const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

/**
 * Compactacao ZIP real protegida por senha, implementada sem dependencia externa.
 * Formato: WinZip AES (AE-2), o mesmo aceito por 7-Zip, WinZip e Info-ZIP,
 * com PBKDF2-HMAC-SHA1 (1000 iteracoes), AES-256-CTR e codigo de autenticacao
 * HMAC-SHA1. Alem do AES, o container .aes do proprio projeto e suportado.
 */

const ASSINATURA_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ASSINATURA_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const METODO_STORED = 0;
const METODO_DEFLATE = 8;
const METODO_AES = 99;
const VERSAO_AES = 51;
const FORTE_AES = 0x03;
const ITERACOES_PBKDF2 = 1000;
const TAMANHO_SAL = 16;
const TAMANHO_VERIFICACAO = 2;
const TAMANHO_AUTENTICACAO = 10;

const MAGIC_AES_PROPRIO = Buffer.from('SBACAES1', 'ascii');

function senhaDeAmbiente({ obrigatoria = true } = {}) {
  const senha = process.env.ZIP_PASSWORD;
  if (!senha) {
    if (obrigatoria) throw new Error('ZIP_PASSWORD nao esta configurada; a compactacao protegida exige uma senha.');
    return null;
  }
  return senha;
}

function derivarChaves(senha, sal, tamanhoChave, tamanhoVerificacao) {
  const material = crypto.pbkdf2Sync(senha.normalize('NFC'), sal, ITERACOES_PBKDF2, tamanhoChave * 2 + tamanhoVerificacao, 'sha1');
  return {
    chaveCifra: material.subarray(0, tamanhoChave),
    chaveAutenticacao: material.subarray(tamanhoChave, tamanhoChave * 2),
    chaveVerificacao: material.subarray(tamanhoChave * 2)
  };
}

function aesCtrWinZip(data, key) {
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  const output = Buffer.alloc(data.length);
  let counter = 1;
  for (let offset = 0; offset < data.length; offset += 16, counter += 1) {
    const block = Buffer.alloc(16);
    block.writeUInt32LE(counter, 0);
    const stream = cipher.update(block);
    const length = Math.min(16, data.length - offset);
    for (let i = 0; i < length; i += 1) output[offset + i] = data[offset + i] ^ stream[i];
  }
  cipher.final();
  return output;
}

function aesExtraField(realMethod) {
  const payload = Buffer.concat([paraInteiro16(2), Buffer.from('AE', 'ascii'), Buffer.from([3]), paraInteiro16(realMethod)]);
  return Buffer.concat([paraInteiro16(0x9901), paraInteiro16(payload.length), payload]);
}

function inverter32(valor) {
  return (((valor >>> 24) & 0xff) | ((valor >>> 8) & 0xff00) | ((valor << 8) & 0xff0000) | ((valor << 24) >>> 0)) >>> 0;
}

function paraInteiro16(valor) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(valor & 0xffff);
  return buffer;
}

function crc32De(dados) {
  const tabelaCrc = tabelaCrcGlobal();
  let crc = 0xffffffff;
  for (let i = 0; i < dados.length; i += 1) crc = tabelaCrc[(crc ^ dados[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

let cacheTabelaCrc = null;
function tabelaCrcGlobal() {
  if (cacheTabelaCrc) return cacheTabelaCrc;
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  cacheTabelaCrc = tabela;
  return tabela;
}

function dataDos(dos) {
  const segundos = Math.floor(dos / 2);
  return {
    hora: Math.floor(segundos / 3600) % 24,
    minuto: Math.floor(segundos / 60) % 60,
    segundo: Math.floor(segundos) % 60
  };
}

/**
 * Cria um ZIP protegido por senha com um unico arquivo (deflate + AES-256).
 * A implementação nativa gera WinZip AES e não depende de ferramenta externa.
 */
async function compactarProtegido(origem, destino, opcoes = {}) {
  const senha = senhaDeAmbiente();
  const conteudo = await fsp.readFile(origem);
  const compactado = zlib.deflateRawSync(conteudo, { level: 6 });
  const usarDeflate = compactado.length < conteudo.length;
  const dados = usarDeflate ? compactado : conteudo;
  const metodoReal = usarDeflate ? METODO_DEFLATE : METODO_STORED;
  const crc = crc32De(conteudo);
  const sal = crypto.randomBytes(TAMANHO_SAL);
  const { chaveCifra, chaveAutenticacao, chaveVerificacao } = derivarChaves(senha, sal, 32, TAMANHO_VERIFICACAO);
  const textoCifrado = aesCtrWinZip(dados, chaveCifra);
  const codigoAutenticacao = crypto.createHmac('sha1', chaveAutenticacao).update(textoCifrado).digest().subarray(0, TAMANHO_AUTENTICACAO);
  const pacoteCifrado = Buffer.concat([sal, chaveVerificacao, textoCifrado, codigoAutenticacao]);
  const extra = aesExtraField(metodoReal);
  const nome = Buffer.from(path.basename(origem), 'utf8');
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const flags = 0x0801;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(ASSINATURA_LOCAL.readUInt32LE(0), 0);
  localHeader.writeUInt16LE(VERSAO_AES, 4);
  localHeader.writeUInt16LE(flags, 6);
  localHeader.writeUInt16LE(METODO_AES, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(0, 14); // AE-2 stores no CRC; HMAC authenticates the encrypted payload.
  localHeader.writeUInt32LE(pacoteCifrado.length, 18);
  localHeader.writeUInt32LE(conteudo.length, 22);
  localHeader.writeUInt16LE(nome.length, 26);
  localHeader.writeUInt16LE(extra.length, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(ASSINATURA_CENTRAL.readUInt32LE(0), 0);
  centralHeader.writeUInt16LE(0x031e, 4); // Unix creator, ZIP 3.0.
  centralHeader.writeUInt16LE(VERSAO_AES, 6);
  centralHeader.writeUInt16LE(flags, 8);
  centralHeader.writeUInt16LE(METODO_AES, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(pacoteCifrado.length, 20);
  centralHeader.writeUInt32LE(conteudo.length, 24);
  centralHeader.writeUInt16LE(nome.length, 28);
  centralHeader.writeUInt16LE(extra.length, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const local = Buffer.concat([localHeader, nome, extra, pacoteCifrado]);
  const offsetCentral = local.length;
  const central = Buffer.concat([centralHeader, nome, extra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD.readUInt32LE(0), 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offsetCentral, 16);

  await fsp.mkdir(path.dirname(destino), { recursive: true });
  await fsp.writeFile(destino, Buffer.concat([local, central, end]));
  opcoes.onProgress?.({ etapa: 'finalizada', bytes: conteudo.length, total: conteudo.length });
  return { caminho: destino, senhaProtegida: true, algoritmo: 'AES-256 (WinZip AE-2)', tamanhoOriginal: conteudo.length, tamanhoFinal: (await fsp.stat(destino)).size };
}
function paraInteiro32(valor) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(valor >>> 0);
  return buffer;
}

async function localizarEOCD(arquivo) {
  const handle = await fsp.open(arquivo, 'r');
  try {
    const tamanho = (await handle.stat()).size;
    const janela = Math.min(tamanho, 66000);
    const buffer = Buffer.alloc(janela);
    await handle.read(buffer, 0, janela, tamanho - janela);
    let posicao = janela - 22;
    while (posicao >= 0) {
      if (buffer.readUInt32LE(posicao) === EOCD.readUInt32LE(0)) return tamanho - janela + posicao;
      posicao -= 1;
    }
    throw new Error('ZIP invalido: registro final (EOCD) nao encontrado.');
  } finally {
    await handle.close();
  }
}

/** Le o diretorio central e devolve a lista de entradas com offset de dados. */
async function lerEntradas(arquivo) {
  const posicaoEOCD = await localizarEOCD(arquivo);
  const handle = await fsp.open(arquivo, 'r');
  try {
    const eocd = Buffer.alloc(22);
    await handle.read(eocd, 0, 22, posicaoEOCD);
    const totalEntradas = eocd.readUInt16LE(10);
    const tamanhoCentral = eocd.readUInt32LE(12);
    const offsetCentral = eocd.readUInt32LE(16);
    const buffer = Buffer.alloc(tamanhoCentral);
    await handle.read(buffer, 0, tamanhoCentral, offsetCentral);

    const entradas = [];
    let cursor = 0;
    for (let i = 0; i < totalEntradas; i += 1) {
      if (buffer.readUInt32LE(cursor) !== ASSINATURA_CENTRAL.readUInt32LE(0)) throw new Error('ZIP invalido: diretorio central corrompido.');
      const tamanhoNome = buffer.readUInt16LE(cursor + 28);
      const tamanhoExtra = buffer.readUInt16LE(cursor + 30);
      const tamanhoComentario = buffer.readUInt16LE(cursor + 32);
      const deslocamentoLocal = buffer.readUInt32LE(cursor + 42);
      const nome = buffer.subarray(cursor + 46, cursor + 46 + tamanhoNome).toString('utf8');
      const inicioExtra = cursor + 46 + tamanhoNome;
      const extra = buffer.subarray(inicioExtra, inicioExtra + tamanhoExtra);
      entradas.push({
        nome,
        metodo: buffer.readUInt16LE(cursor + 10),
        crc: buffer.readUInt32LE(cursor + 16),
        tamanhoComprimido: buffer.readUInt32LE(cursor + 20),
        tamanhoOriginal: buffer.readUInt32LE(cursor + 24),
        deslocamentoLocal,
        versaoExtracao: buffer.readUInt16LE(cursor + 6),
        extra
      });
      cursor = inicioExtra + tamanhoExtra + tamanhoComentario;
    }
    return entradas;
  } finally {
    await handle.close();
  }
}

function lerBlocosAes(extra) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const data = cursor + 4;
    if (data + size > extra.length) throw new Error('ZIP invalido: campo extra truncado.');
    if (id === 0x9901) {
      if (size !== 7) throw new Error('Campo WinZip AES invalido.');
      const vendorVersion = extra.readUInt16LE(data);
      const vendor = extra.subarray(data + 2, data + 4).toString('ascii');
      const strength = extra[data + 4];
      if (vendor !== 'AE' || vendorVersion !== 2 || strength !== 3) throw new Error('Formato WinZip AES nao suportado.');
      return { metodoReal: extra.readUInt16LE(data + 5), tamanhoSal: 16, inicioDados: 0 };
    }
    cursor = data + size;
  }
  throw new Error('ZIP AES sem campo de parametros WinZip AES.');
}

async function lerEntrada(arquivo, entrada, senha) {
  const handle = await fsp.open(arquivo, 'r');
  try {
    const localHeader = Buffer.alloc(30);
    await handle.read(localHeader, 0, localHeader.length, entrada.deslocamentoLocal);
    if (localHeader.readUInt32LE(0) !== ASSINATURA_LOCAL.readUInt32LE(0)) throw new Error('Cabecalho local ZIP invalido.');
    const nameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataOffset = entrada.deslocamentoLocal + 30 + nameLength + extraLength;
    const packed = Buffer.alloc(entrada.tamanhoComprimido);
    await handle.read(packed, 0, packed.length, dataOffset);

    let dados;
    if (entrada.metodo === METODO_AES) {
      const aes = lerBlocosAes(entrada.extra);
      if (packed.length < aes.tamanhoSal + TAMANHO_VERIFICACAO + TAMANHO_AUTENTICACAO) throw new Error('Entrada WinZip AES truncada.');
      const salt = packed.subarray(0, aes.tamanhoSal);
      const verifier = packed.subarray(aes.tamanhoSal, aes.tamanhoSal + TAMANHO_VERIFICACAO);
      const cipherEnd = packed.length - TAMANHO_AUTENTICACAO;
      const ciphertext = packed.subarray(aes.tamanhoSal + TAMANHO_VERIFICACAO, cipherEnd);
      const authCode = packed.subarray(cipherEnd);
      const keys = derivarChaves(senha ?? senhaDeAmbiente(), salt, 32, TAMANHO_VERIFICACAO);
      if (!crypto.timingSafeEqual(keys.chaveVerificacao, verifier)) throw new Error('Senha do ZIP incorreta.');
      const expectedAuth = crypto.createHmac('sha1', keys.chaveAutenticacao).update(ciphertext).digest().subarray(0, TAMANHO_AUTENTICACAO);
      if (!crypto.timingSafeEqual(expectedAuth, authCode)) throw new Error('Autenticacao WinZip AES invalida: arquivo corrompido.');
      const compressed = aesCtrWinZip(ciphertext, keys.chaveCifra);
      if (aes.metodoReal === METODO_DEFLATE) dados = zlib.inflateRawSync(compressed);
      else if (aes.metodoReal === METODO_STORED) dados = compressed;
      else throw new Error(`Metodo de compactacao ZIP nao suportado (${aes.metodoReal}).`);
    } else if (entrada.metodo === METODO_DEFLATE) dados = zlib.inflateRawSync(packed);
    else if (entrada.metodo === METODO_STORED) dados = packed;
    else throw new Error(`Metodo ZIP nao suportado (${entrada.metodo}).`);

    if (dados.length !== entrada.tamanhoOriginal) throw new Error('Conteudo descompactado com tamanho inesperado (arquivo corrompido).');
    if (entrada.metodo !== METODO_AES && entrada.crc && crc32De(dados) !== entrada.crc) throw new Error('CRC32 divergente: conteudo corrompido.');
    return dados;
  } finally { await handle.close(); }
}
/**
 * Extrai de um backup compactado: aceita ZIP protegido por senha e o container .aes do projeto.
 * Devolve o caminho do arquivo .dump utilizavel pelo pg_restore.
 */
async function prepararParaRestauracao(arquivo, destino, senhaInformada, opcoes = {}) {
  const nome = path.basename(arquivo);
  const alvo = path.join(destino, nome.replace(/\.zip$/i, '').replace(/\.aes$/i, '') || 'restauracao.dump');
  if (/\.zip$/i.test(nome)) {
    opcoes.onProgress?.({ etapa: 'extraindo', percentual: 20, mensagem: 'Extraindo ZIP protegido por senha.' });
    const entradas = await lerEntradas(arquivo);
    if (!entradas.length) throw new Error('ZIP vazio.');
    if (entradas.length !== 1 || entradas[0].nome.endsWith('/')) throw new Error('O backup ZIP deve conter exatamente um arquivo.');
    const conteudo = await lerEntrada(arquivo, entradas[0], senhaInformada ?? senhaDeAmbiente());
    const extraido = path.join(destino, path.basename(entradas[0].nome));
    await fsp.writeFile(extraido, conteudo, { flag: 'wx' });
    if (/\.aes$/i.test(extraido)) return prepararParaRestauracao(extraido, destino, senhaInformada, opcoes);
    return { arquivo: extraido, conteudo, origem: 'zip-protegido' };
  }
  if (/\.aes$/i.test(nome)) {
    opcoes.onProgress?.({ etapa: 'descriptografando', percentual: 20, mensagem: 'Descriptografando container AES.' });
    const { descriptografarBuffer } = require('./criptografia.service');
    const conteudo = await descriptografarBuffer(arquivo);
    await fsp.writeFile(alvo, conteudo);
    return { arquivo: alvo, conteudo, origem: 'aes' };
  }
  return { arquivo: arquivo, conteudo: null, origem: 'plain' };
}

function compactacaoDisponivel() {
  return senhaDeAmbiente({ obrigatoria: false }) !== null;
}

module.exports = {
  compactarProtegido,
  lerEntradas,
  lerEntrada,
  prepararParaRestauracao,
  senhaDeAmbiente,
  derivarChaves,
  crc32De,
  compactacaoDisponivel,
  METODO_AES,
  MAGIC_AES_PROPRIO
};
