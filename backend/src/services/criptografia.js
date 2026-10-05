/**
 * criptografia.js — AES-256-GCM com chave derivada por scrypt.
 *
 * Formato do arquivo (.enc):
 *   [0..15]   salt (16 bytes, aleatório por arquivo)
 *   [16..27]  IV (12 bytes, aleatório por arquivo)
 *   [28..43]  tag GCM (16 bytes)
 *   [44..]    dados cifrados
 *
 * Usa streaming (crypto.createCipheriv em pipeline) para suportar bancos
 * grandes sem ler o dump inteiro em memória.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const SALT_TAM = 16;
const IV_TAM = 12;
const TAG_TAM = 16;

function derivarChave(chave, salt) {
  // scrypt: N=16384, r=8, p=1 → 32 bytes (AES-256)
  return crypto.scryptSync(String(chave), salt, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Criptografa um arquivo em streaming.
 * @returns {Promise<string>} caminho do arquivo .enc
 */
async function criptografarArquivo(arquivoEntrada, chave) {
  const salt = crypto.randomBytes(SALT_TAM);
  const iv = crypto.randomBytes(IV_TAM);
  const chaveDerivada = derivarChave(chave, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', chaveDerivada, iv);

  const saida = arquivoEntrada + '.enc';
  const ws = fs.createWriteStream(saida);
  const rs = fs.createReadStream(arquivoEntrada);

  // Escreve salt + IV antes dos dados cifrados.
  ws.write(salt);
  ws.write(iv);

  // Transform que anexa o tag GCM ao final (após o cipher finalizar).
  const tagWriter = new Transform({
    transform(chunk, enc, cb) { cb(null, chunk); },
    flush(cb) { this.push(cipher.getAuthTag()); cb(); },
  });

  // Pipeline: rs → cipher → tagWriter → ws (streaming, sem ler tudo em memória).
  await pipeline(rs, cipher, tagWriter, ws);

  // Remove o arquivo em claro (segredo não permanece em disco).
  try { fs.unlinkSync(arquivoEntrada); } catch { /* já removido */ }
  return saida;
}

/**
 * Descriptografa um arquivo .enc em streaming.
 * @returns {Promise<string>} caminho do arquivo descriptografado
 */
function descriptografarArquivo(arquivoEntrada, chave, arquivoSaida) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(arquivoEntrada);
    // Lê apenas o ciphertext (pula salt+iv no início e o tag no final).
    const rs = fs.createReadStream(arquivoEntrada, {
      start: SALT_TAM + IV_TAM,
      end: stat.size - TAG_TAM - 1,
    });
    const fd = fs.openSync(arquivoEntrada, 'r');
    const cab = Buffer.alloc(SALT_TAM + IV_TAM);
    fs.readSync(fd, cab, 0, cab.length, 0);
    fs.closeSync(fd);

    const salt = cab.subarray(0, SALT_TAM);
    const iv = cab.subarray(SALT_TAM, SALT_TAM + IV_TAM);
    const chaveDerivada = derivarChave(chave, salt);

    // O tag GCM fica nos últimos 16 bytes do arquivo; o decipher precisa dele
    // antes de finalizar, então lemos o final do arquivo separadamente.
    const tag = Buffer.alloc(TAG_TAM);
    const fdTag = fs.openSync(arquivoEntrada, 'r');
    fs.readSync(fdTag, tag, 0, TAG_TAM, stat.size - TAG_TAM);
    fs.closeSync(fdTag);

    const decipher = crypto.createDecipheriv('aes-256-gcm', chaveDerivada, iv);
    decipher.setAuthTag(tag);

    const ws = fs.createWriteStream(arquivoSaida);
    rs.on('error', reject);
    decipher.on('error', (e) => reject(new Error('Falha ao descriptografar: chave incorreta ou arquivo corrompido.')));
    ws.on('error', reject);
    rs.pipe(decipher).pipe(ws);
    ws.on('finish', () => resolve(arquivoSaida));
  });
}

module.exports = { criptografarArquivo, descriptografarArquivo, derivarChave };
