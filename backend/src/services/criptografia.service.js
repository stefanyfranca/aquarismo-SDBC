const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('SBACAES1', 'ascii');
const TAMANHO_CABECALHO = MAGIC.length + 12 + 16;
const TAMANHO_BLOCO = 1024 * 1024;
const ALGORITMO = 'aes-256-gcm';
const EXTENSAO = '.aes';

/**
 * Chave AES-256 de 32 bytes vinda do ambiente.
 * Aceita base64, hexadecimal (64 caracteres) ou passphrase (derivada por PBKDF2),
 * para nunca exigir que o operador gere uma chave valida na mao.
 */
function chaveDeAmbiente({ obrigatoria = true } = {}) {
  const bruta = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (!bruta) {
    if (obrigatoria) throw new Error('BACKUP_ENCRYPTION_KEY nao esta configurada; a criptografia exige uma chave.');
    return null;
  }
  const decodificada = decodificarChave(bruta);
  return decodificada.length === 32 ? decodificada : crypto.pbkdf2Sync(bruta, 'sbac-backup-aes-256', 100000, 32, 'sha256');
}

function decodificarChave(bruta) {
  if (/^[0-9a-fA-F]{64}$/.test(bruta)) return Buffer.from(bruta, 'hex');
  return Buffer.from(bruta, 'base64');
}

function tamanhoDe(arquivo) {
  try {
    return fs.statSync(arquivo).size;
  } catch {
    return null;
  }
}

function progressoAgendado(callback, intervaloMs = 300) {
  if (typeof callback !== 'function') return () => {};
  let ultimo = 0;
  const timer = setInterval(() => {
    const agora = Date.now();
    if (agora - ultimo < intervaloMs) return;
    ultimo = agora;
    callback(agora);
  }, intervaloMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Escreve o cabecalho (magic + IV + auth tag) no inicio do arquivo cifrado. */
async function gravarCabecalho(destino, iv, authTag) {
  const cabecalho = Buffer.concat([MAGIC, iv, authTag]);
  const handle = await fsp.open(destino, 'r+');
  try {
    await handle.write(cabecalho, 0, cabecalho.length, 0);
  } finally {
    await handle.close();
  }
}

/** Le o cabecalho e devolve os offsets dos dados e do texto cifrado. */
async function lerCabecalho(arquivo) {
  const handle = await fsp.open(arquivo, 'r');
  try {
    const buffer = Buffer.alloc(TAMANHO_CABECALHO);
    const { bytesRead } = await handle.read(buffer, 0, TAMANHO_CABECALHO, 0);
    if (bytesRead < TAMANHO_CABECALHO) throw new Error('Arquivo criptografado invalido: cabecalho incompleto.');
    if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Arquivo nao possui o container de criptografia desta plataforma (SBACAES1).');
    }
    const tamanho = (await handle.stat()).size;
    return {
      iv: buffer.subarray(MAGIC.length, MAGIC.length + 12),
      authTag: buffer.subarray(MAGIC.length + 12, TAMANHO_CABECALHO),
      tamanho,
      inicioDados: TAMANHO_CABECALHO,
      tamanhoCifrado: tamanho - TAMANHO_CABECALHO
    };
  } finally {
    await handle.close();
  }
}

/** Criptografa em streaming (AES-256-GCM). Nunca carrega o dump inteiro na memoria. */
async function criptografarArquivo(origem, destino, opcoes = {}) {
  const chave = chaveDeAmbiente({ obrigatoria: true });
  await fsp.mkdir(path.dirname(destino), { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);
  const entrada = fs.createReadStream(origem, { highWaterMark: TAMANHO_BLOCO });
  const saida = fs.createWriteStream(destino);
  const pararProgresso = progressoAgendado(opcoes.onProgress);
  try {
    await pipeline(entrada, cipher, saida);
  } finally {
    pararProgresso();
  }
  await gravarCabecalho(destino, iv, cipher.getAuthTag());
  opcoes.onProgress?.({ etapa: 'finalizada', bytes: tamanhoDe(destino), total: tamanhoDe(destino) });
  return destino;
}

async function criptografarBuffer(origem, opcoes = {}) {
  const chave = chaveDeAmbiente({ obrigatoria: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);
  const cifrado = Buffer.concat([cipher.update(origem), cipher.final()]);
  opcoes.onProgress?.({ etapa: 'finalizada', bytes: cifrado.length, total: cifrado.length });
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), cifrado]);
}

async function descriptografarBuffer(origem) {
  const { iv, authTag, inicioDados, tamanhoCifrado } = await lerCabecalho(origem);
  const dados = await fsp.readFile(origem);
  const decipher = crypto.createDecipheriv(ALGORITMO, chaveDeAmbiente({ obrigatoria: true }), iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(dados.subarray(inicioDados, inicioDados + tamanhoCifrado)), decipher.final()]);
  } catch {
    throw new Error('Falha ao descriptografar: chave invalida ou arquivo corrompido.');
  }
}

/** Descriptografa para disco, de forma segmentada (stream) para arquivos grandes. */
async function descriptografarArquivo(origem, destino, opcoes = {}) {
  const { iv, authTag, tamanhoCifrado } = await lerCabecalho(origem);
  const chave = chaveDeAmbiente({ obrigatoria: true });
  await fsp.mkdir(path.dirname(destino), { recursive: true });
  const entrada = fs.createReadStream(origem, {
    start: TAMANHO_CABECALHO,
    end: TAMANHO_CABECALHO + tamanhoCifrado - 1,
    highWaterMark: TAMANHO_BLOCO
  });
  const decipher = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decipher.setAuthTag(authTag);
  const saida = fs.createWriteStream(destino);
  const pararProgresso = progressoAgendado(opcoes.onProgress);
  try {
    await pipeline(entrada, decipher, saida);
  } finally {
    pararProgresso();
  }
  opcoes.onProgress?.({ etapa: 'finalizada', bytes: tamanhoDe(destino), total: tamanhoDe(destino) });
  return destino;
}

function chaveConfigurada() {
  try {
    return chaveDeAmbiente({ obrigatoria: true }).length === 32;
  } catch {
    return false;
  }
}

module.exports = {
  criptografarArquivo,
  criptografarBuffer,
  descriptografarArquivo,
  descriptografarBuffer,
  lerCabecalho,
  chaveDeAmbiente,
  decodificarChave,
  criptografiaDisponivel: () => Boolean((process.env.BACKUP_ENCRYPTION_KEY || '').trim()),
  chaveConfigurada,
  EXTENSAO
};