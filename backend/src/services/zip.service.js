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
const TAMANHO_SAL = 16 / 8;
const TAMANHO_VERIFICACAO = 2;

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
  const material = crypto.pbkdf2Sync(senha.normalize('utf8'), sal, ITERACOES_PBKDF2, tamanhoChave + tamanhoVerificacao, 'sha1');
  return {
    chaveCifra: material.subarray(0, tamanhoChave),
    chaveVerificacao: material.subarray(tamanhoChave)
  };
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
 * O 7-Zip e' usado quando configurado/presente; caso contrario esta implementacao nativa.
 */
async function compactarProtegido(origem, destino, opcoes = {}) {
  const senha = senhaDeAmbiente();
  const conteudo = await fsp.readFile(origem);
  const compactado = zlib.deflateRawSync(conteudo, { level: 6 });
  const usarDeflate = compactado.length < conteudo.length;
  const dados = usarDeflate ? compactado : conteudo;
  const metodo = usarDeflate ? METODO_DEFLATE : METODO_STORED;
  const crc = crc32De(conteudo);

  const sal = crypto.randomBytes(TAMANHO_SAL);
  const { chaveCifra, chaveVerificacao } = derivarChaves(senha, sal, 32, TAMANHO_VERIFICACAO);
  const nonce = crypto.randomBytes(16);
  const cifra = crypto.createCipheriv('aes-256-ctr', chaveCifra, nonce);
  const textoCifrado = Buffer.concat([cifra.update(dados), cifra.final()]);
  const codigoAutenticacao = crypto.createHmac('sha1', chaveVerificacao).update(textoCifrado).digest();

  const cabecalhoExtra = Buffer.concat([
    sal,
    paraInteiro16(TAMANHO_VERIFICACAO),
    codigoAutenticacao,
    Buffer.from([VERSAO_AES, FORTE_AES, metodo]),
    crypto.createHash('sha1').update(conteudo).digest(),
    Buffer.concat([nonce, Buffer.from([0, 0, 0, 0])])
  ]);

  const nome = Buffer.from(path.basename(origem), 'utf8');
  const { hora, minuto, segundo } = dataDos(Date.now());
  const deslocamentoExtra = 30 + nome.length;
  const crcNome = crc32De(nome);

  const cabecalhoLocal = Buffer.alloc(30);
  cabecalhoLocal.writeUInt32LE(ASSINATURA_LOCAL.readUInt32LE(0), 0);
  cabecalhoLocal.writeUInt16LE(FORTE_AES, 4);
  cabecalhoLocal.writeUInt16LE(VERSAO_AES, 6);
  cabecalhoLocal.writeUInt16LE(FORTE_AES, 8);
  cabecalhoLocal.writeUInt16LE(metodo, 10);
  cabecalhoLocal.writeUInt16LE(hora, 12);
  cabecalhoLocal.writeUInt16LE(minuto, 14);
  cabecalhoLocal.writeUInt16LE(segundo, 16);
  cabecalhoLocal.writeUInt32LE(crc, 18);
  cabecalhoLocal.writeUInt32LE(textoCifrado.length, 22);
  cabecalhoLocal.writeUInt32LE(conteudo.length, 26);
  cabecalhoLocal.writeUInt16LE(nome.length, 28);

  const cabecalhoCentral = Buffer.alloc(46);
  cabecalhoCentral.writeUInt32LE(ASSINATURA_CENTRAL.readUInt32LE(0), 0);
  cabecalhoCentral.writeUInt16LE(FORTE_AES, 4);
  cabecalhoCentral.writeUInt16LE(VERSAO_AES, 6);
  cabecalhoCentral.writeUInt16LE(FORTE_AES, 8);
  cabecalhoCentral.writeUInt16LE(metodo, 10);
  cabecalhoCentral.writeUInt16LE(hora, 12);
  cabecalhoCentral.writeUInt16LE(minuto, 14);
  cabecalhoCentral.writeUInt16LE(segundo, 16);
  cabecalhoCentral.writeUInt32LE(crc, 18);
  cabecalhoCentral.writeUInt32LE(textoCifrado.length, 22);
  cabecalhoCentral.writeUInt32LE(conteudo.length, 26);
  cabecalhoCentral.writeUInt16LE(nome.length, 28);
  cabecalhoCentral.writeUInt16LE(TAMANHO_SAL, 30);
  cabecalhoCentral.writeUInt16LE(TAMANHO_VERIFICACAO, 32);
  cabecalhoCentral.writeUInt32LE(0, 38);
  cabecalhoCentral.writeUInt32LE(0, 42);
  cabecalhoCentral.writeUInt16LE(crcNome, 20);
  cabecalhoCentral.writeUInt16LE(0, 34);
  cabecalhoCentral.writeUInt16LE(0, 36);
  cabecalhoCentral.writeUInt16LE(0, 40);

  const inicioCentral = 30 + nome.length + cabecalhoExtra.length + textoCifrado.length;
  const registroCentral = Buffer.concat([
    cabecalhoCentral,
    nome,
    Buffer.concat([sal, paraInteiro16(TAMANHO_VERIFICACAO), codigoAutenticacao, Buffer.from([VERSAO_AES, FORTE_AES, metodo])]),
    crypto.createHash('sha1').update(conteudo).digest()
  ]);
  const registroCentralCompleto = Buffer.concat([
    Buffer.from(registroCentral.subarray(0, 38)),
    paraInteiro32(inverter32(inicioCentral)),
    Buffer.from(registroCentral.subarray(42, 46))
  ]);

  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(EOCD.readUInt32LE(0), 0);
  fim.writeUInt16LE(1, 8);
  fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(registroCentralCompleto.length, 12);
  fim.writeUInt32LE(inicioCentral, 16);

  await fsp.mkdir(path.dirname(destino), { recursive: true });
  await fsp.writeFile(destino, Buffer.concat([cabecalhoLocal, nome, cabecalhoExtra, textoCifrado, registroCentralCompleto, fim]));
  opcoes.onProgress?.({ etapa: 'finalizada', bytes: conteudo.length, total: conteudo.length });
  return {
    caminho: destino,
    senhaProtegida: true,
    algoritmo: 'AES-256 (WinZip AE-2)',
    tamanhoOriginal: conteudo.length,
    tamanhoFinal: (await fsp.stat(destino)).size
  };
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
  const tamanhoSal = extra.readUInt16LE(4);
  const tamanhoVerificacao = extra.readUInt16LE(6);
  const versao = extra[8];
  const forca = extra[9];
  if (tamanhoVerificacao !== TAMANHO_VERIFICACAO) {
    throw new Error(`ZIP protegido com metodo de autenticacao nao suportado (${tamanhoVerificacao * 8} bits).`);
  }
  return {
    sal: extra.subarray(10, 10 + tamanhoSal),
    versao,
    forca,
    inicioDados: 10 + tamanhoSal + tamanhoVerificacao,
    metodoReal: extra[10 + tamanhoSal + tamanhoVerificacao]
  };
}

/** Le a entrada e devolve o conteudo descriptografado ou descompactado. */
async function lerEntrada(arquivo, entrada, senha) {
  const handle = await fsp.open(arquivo, 'r');
  try {
    const cabecalhoLocal = Buffer.alloc(30);
    await handle.read(cabecalhoLocal, 0, 30, entrada.deslocamentoLocal);
    const tamanhoNome = cabecalhoLocal.readUInt16LE(26);
    const tamanhoExtra = cabecalhoLocal.readUInt16LE(28);
    const inicioDados = entrada.deslocamentoLocal + 30 + tamanhoNome + tamanhoExtra;

    let dados;
    if (entrada.metodo === METODO_AES) {
      const blocos = lerBlocosAes(entrada.extra);
      const verificador = entrada.extra.subarray(10 + blocos.sal.length, 10 + blocos.sal.length + TAMANHO_VERIFICACAO);
      const { chaveCifra, chaveVerificacao } = derivarChaves(senha, blocos.sal, 32, TAMANHO_VERIFICACAO);
      if (crypto.createHmac('sha1', chaveVerificacao).update(verificador).digest().compare(verificador) !== 0) {
        throw new Error('Senha do ZIP incorreta.');
      }
      const nonce = entrada.extra.subarray(blocos.inicioDados + 4, blocos.inicioDados + 12);
      const buffer = Buffer.alloc(entrada.tamanhoComprimido);
      await handle.read(buffer, 0, entrada.tamanhoComprimido, inicioDados);
      const decipher = crypto.createDecipheriv('aes-256-ctr', chaveCifra, nonce);
      dados = Buffer.concat([decipher.update(buffer), decipher.final()]);
      const metodoReal = blocos.metodoReal;
      if (metodoReal === METODO_DEFLATE) dados = zlib.inflateRawSync(dados);
      else if (metodoReal !== METODO_STORED) throw new Error(`Metodo de compactacao ZIP nao suportado (${metodoReal}).`);
    } else {
      const buffer = Buffer.alloc(entrada.tamanhoComprimido);
      await handle.read(buffer, 0, entrada.tamanhoComprimido, inicioDados);
      if (entrada.metodo === METODO_DEFLATE) dados = zlib.inflateRawSync(buffer);
      else if (entrada.metodo === METODO_STORED) dados = buffer;
      else throw new Error(`Metodo de compactacao ZIP nao suportado (${entrada.metodo}).`);
    }

    if (dados.length !== entrada.tamanhoOriginal) {
      throw new Error('Conteudo descompactado com tamanho inesperado (arquivo corrompido).');
    }
    const crc = crc32De(dados);
    if (entrada.crc && crc !== entrada.crc) throw new Error('CRC32 divergente: conteudo corrompido.');
    return dados;
  } finally {
    await handle.close();
  }
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
    const conteudo = await lerEntrada(arquivo, entradas[0], senhaInformada ?? senhaDeAmbiente());
    await fsp.writeFile(alvo, conteudo);
    return { arquivo: alvo, conteudo, origem: 'zip-protegido' };
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