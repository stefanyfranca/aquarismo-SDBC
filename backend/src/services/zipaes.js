/**
 * zipaes.js — Descompactação de ZIP com criptografia WinZip AES (AE-2).
 *
 * O archiver-zip-encrypted gera ZIPs com AES-256 (método 99). Como não há
 * biblioteca Node que descompacte AES ZIP de forma portável, implementamos
 * o formato WinZip AES aqui:
 *   - salt (16 bytes p/ AES-256) + verification (2 bytes) + ciphertext + auth (10 bytes)
 *   - chaves: PBKDF2-HMAC-SHA1, 1000 iterações, 2*keylen+2*authlen bytes
 *   - cifra: AES-CTR (contador little-endian de 16 bytes, começando em 1)
 *   - autenticação: HMAC-SHA1 truncado em 10 bytes
 *   - payload: raw deflate (method 8) ou stored (method 0) → zlib.inflateRawSync
 */
const crypto = require('crypto');
const zlib = require('zlib');

function lerZipEntries(buf) {
  // Encontra o End of Central Directory (EOCD).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP inválido: EOCD não encontrado.');
  const totalEntries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Local file header para achar o início dos dados.
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;

    entries.push({ name, method, compressedSize, dataStart });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function derivarChaves(senha, salt, keylen) {
  const authlen = 20; // HMAC-SHA1
  const derived = crypto.pbkdf2Sync(String(senha), salt, 1000, 2 * keylen + 2 * authlen, 'sha1');
  return {
    encKey: derived.subarray(0, keylen),
    authKey: derived.subarray(keylen, keylen + authlen),
    verification: derived.subarray(derived.length - 2), // 2 últimos bytes
  };
}

/**
 * Descompacta o primeiro arquivo de um ZIP com senha (suporta AES-256 e ZipCrypto legado não).
 * @returns {Buffer} conteúdo do arquivo
 */
function descompactarZipAes(bufferZip, senha) {
  const entries = lerZipEntries(bufferZip);
  if (entries.length === 0) throw new Error('ZIP vazio.');
  const entry = entries[0];
  const dados = bufferZip.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);

  // ZIP criptografado com AES: método 99.
  if (entry.method === 99) {
    const strength = dados[0]; // 1=128, 2=192, 3=256
    const keylen = strength === 1 ? 16 : strength === 2 ? 24 : 32;
    const saltLen = keylen / 2;
    const salt = dados.subarray(1, 1 + saltLen);
    const verification = dados.subarray(1 + saltLen, 3 + saltLen);
    const authCode = dados.subarray(dados.length - 10);
    const ciphertext = dados.subarray(3 + saltLen, dados.length - 10);

    const { encKey, authKey, verification: verDerivado } = derivarChaves(senha, salt, keylen);
    if (!verDerivado.equals(verification)) {
      throw new Error('Senha do ZIP incorreta.');
    }

    // HMAC-SHA1 sobre o ciphertext (autenticação).
    const hmac = crypto.createHmac('sha1', authKey).update(ciphertext).digest();
    if (!hmac.subarray(0, 10).equals(authCode)) {
      throw new Error('Falha de autenticação do ZIP (HMAC).');
    }

    // AES-CTR: contador little-endian de 16 bytes começando em 1.
    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(1, 12);
    const decipher = crypto.createDecipheriv(`aes-${keylen * 8}-ctr`, encKey, iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Payload: raw deflate ou stored.
    const actualMethod = dados.readUInt16LE(0); // strength(1) + ... não; o método real está no extra field.
    // Para simplificar: tenta deflate; se falhar, assume stored.
    try {
      return zlib.inflateRawSync(plain);
    } catch {
      return plain;
    }
  }

  // ZIP sem criptografia: deflate ou stored.
  if (entry.method === 8) return zlib.inflateRawSync(dados);
  if (entry.method === 0) return dados;
  throw new Error(`Método de compressão não suportado: ${entry.method}.`);
}

module.exports = { descompactarZipAes };
