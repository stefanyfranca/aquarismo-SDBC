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
const path = require('path');

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
    const extra = buf.subarray(localOffset + 30 + lhNameLen, localOffset + 30 + lhNameLen + lhExtraLen);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;

    entries.push({ name, method, compressedSize, dataStart, extra });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extrai a strength (1=128, 2=192, 3=256) do extra field WinZip AES (0x9901).
 * @returns {number|null}
 */
function lerStrengthAes(extra) {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    if (id === 0x9901 && size >= 7) return extra.readUInt8(i + 4 + 4); // version(2) + vendor(2)
    i += 4 + size;
  }
  return null;
}

function derivarChaves(senha, salt, keylen) {
  const authlen = 20; // HMAC-SHA1
  const derived = crypto.pbkdf2Sync(String(senha), salt, 1000, 2 * keylen + 2 * authlen, 'sha1');
  return {
    encKey: derived.subarray(0, keylen),
    authKey: derived.subarray(keylen, keylen + authlen),
    // Alguns geradores (archiver-zip-encrypted) estendem a chave HMAC até 2*keylen.
    authKeyLargo: derived.subarray(keylen, 2 * keylen),
    // Valor de verificação da senha: logo após a chave de autenticação
    // (posição 2*keylen), não no fim do buffer derivado.
    verification: derived.subarray(2 * keylen, 2 * keylen + 2),
  };
}

/**
 * AES em modo CTR com contador little-endian (WinZip AES).
 * O 'aes-*-ctr' do Node incrementa o contador como inteiro big-endian de 128 bits,
 * o que diverge do WinZip a partir do 2º bloco — daí o CTR ser feito aqui sobre
 * AES-ECB, incrementando o byte 0 primeiro.
 */
function decifrarCtrLeBlocos(encKey, keylen, ciphertext) {
  const ecb = crypto.createCipheriv(`aes-${keylen * 8}-ecb`, encKey, null);
  ecb.setAutoPadding(false);
  const out = Buffer.allocUnsafe(ciphertext.length);
  const counter = Buffer.alloc(16);
  counter[0] = 1;
  for (let off = 0; off < ciphertext.length; off += 16) {
    const ks = ecb.update(counter);
    const n = Math.min(16, ciphertext.length - off);
    for (let i = 0; i < n; i++) out[off + i] = ciphertext[off + i] ^ ks[i];
    for (let i = 0; i < 16; i++) {
      if (counter[i] === 255) counter[i] = 0;
      else { counter[i]++; break; }
    }
  }
  return out;
}

/**
 * Descompacta o primeiro arquivo de um ZIP com senha (AES-256/WinZip AE-1 e AE-2).
 * @returns {Buffer} conteúdo do arquivo
 */
function descompactarZipAes(bufferZip, senha) {
  const entries = lerZipEntries(bufferZip);
  if (entries.length === 0) throw new Error('ZIP vazio.');
  const entry = entries[0];
  const dados = bufferZip.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);

  // ZIP criptografado com AES: método 99.
  if (entry.method === 99) {
    // AE-1/AE-2 guardam a strength no extra field 0x9901; alguns geradores
    // também a escrevem como primeiro byte dos dados. Não há como saber de
    // antemão: tentamos as combinações e validamos pelo valor de verificação.
    const strengthExtra = lerStrengthAes(entry.extra);
    const keylens = strengthExtra
      ? [strengthExtra === 1 ? 16 : strengthExtra === 2 ? 24 : 32]
      : [32, 16, 24];

    const tentar = (keylen, comByteStrength) => {
      const saltLen = keylen / 2;
      const off = comByteStrength ? 1 : 0;
      if (dados.length < off + saltLen + 2 + 10) return null;
      const salt = dados.subarray(off, off + saltLen);
      const verification = dados.subarray(off + saltLen, off + saltLen + 2);
      const authCode = dados.subarray(dados.length - 10);
      const ciphertext = dados.subarray(off + saltLen + 2, dados.length - 10);
      const chaves = derivarChaves(senha, salt, keylen);
      if (!chaves.verification.equals(verification)) return null;

      // HMAC-SHA1 truncado em 10 bytes sobre o ciphertext.
      const hmacOk = [chaves.authKey, chaves.authKeyLargo].some((k) => (
        crypto.createHmac('sha1', k).update(ciphertext).digest().subarray(0, 10).equals(authCode)
      ));
      return { ...chaves, ciphertext, hmacOk, keylen };
    };

    let r = null;
    for (const keylen of keylens) {
      for (const comByteStrength of [true, false]) {
        r = tentar(keylen, comByteStrength);
        if (r) break;
      }
      if (r) break;
    }
    if (!r) throw new Error('Senha do ZIP incorreta.');
    if (!r.hmacOk) throw new Error('Falha de autenticação do ZIP (HMAC).');

    const plain = decifrarCtrLeBlocos(r.encKey, r.keylen, r.ciphertext);

    // Payload: raw deflate ou stored.
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

/**
 * Nome da primeira entrada do ZIP (o nome interno preserva as camadas:
 * ".dump" ou ".dump.enc"), ou null se o ZIP estiver vazio/inválido.
 */
function nomeDaEntrada(bufferZip) {
  try {
    const entradas = lerZipEntries(bufferZip);
    return entradas.length ? path.basename(entradas[0].name) : null;
  } catch {
    return null;
  }
}

module.exports = { descompactarZipAes, nomeDaEntrada };
