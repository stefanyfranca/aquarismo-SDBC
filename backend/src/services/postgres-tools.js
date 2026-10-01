const fs = require('fs');
const path = require('path');

const FERRAMENTAS = ['pg_dump', 'pg_restore', 'psql', 'pg_isready', 'createdb', 'dropdb'];

// Diretorios habitsuais de instalacao do PostgreSQL no Windows (ordem de prioridade).
const DIRETORIOS_WINDOWS = [
  'C:\\Program Files\\PostgreSQL',
  'C:\\Program Files (x86)\\PostgreSQL',
  'C:\\PostgreSQL',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'PostgreSQL')
];

const cache = new Map();

function existeExecutavel(candidato) {
  try {
    if (!candidato) return false;
    const stats = fs.statSync(candidato);
    return stats.isFile();
  } catch {
    return false;
  }
}

function nomeExecutavel(ferramenta) {
  return process.platform === 'win32' ? `${ferramenta}.exe` : ferramenta;
}

function pastaDoBinario(caminho) {
  return path.dirname(caminho);
}

// Varre as pastas de instalacao do Windows e devolve candidatos ordenados por versao (mais nova primeiro).
function candidatosDoWindows() {
  const candidatos = [];
  for (const raiz of DIRETORIOS_WINDOWS) {
    if (!raiz) continue;
    let installed = [];
    try {
      installed = fs.readdirSync(raiz, { withFileTypes: true })
        .filter((entrada) => entrada.isDirectory())
        .map((entrada) => entrada.name);
    } catch {
      continue;
    }
    const versoes = installed
      .map((nome) => ({ nome, versao: numeroVersao(nome) }))
      .sort((a, b) => b.versao - a.versao);
    for (const { nome } of versoes) {
      const bin = path.join(raiz, nome, 'bin');
      try {
        if (fs.statSync(bin).isDirectory()) candidatos.push(bin);
      } catch {
        // ignora pasta ausente
      }
    }
  }
  return candidatos;
}

function numeroVersao(nome) {
  const digitos = String(nome).match(/\d+/g);
  return digitos ? Number(digitos.join('')) : -1;
}

function candidatosDoPath() {
  const variavel = process.env.PATH || '';
  const separador = process.platform === 'win32' ? ';' : ':';
  return variavel.split(separador).filter(Boolean);
}

function procurarNoPath(ferramenta) {
  const alvo = nomeExecutavel(ferramenta).toLowerCase();
  for (const pasta of candidatosDoPath()) {
    const candidato = path.join(pasta, nomeExecutavel(ferramenta));
    if (existeExecutavel(candidato)) return candidato;
  }
  // O PATH do Windows pode conter entradas sem a extensao mas com o arquivo real em disco.
  for (const pasta of candidatosDoPath()) {
    try {
      const arquivos = fs.readdirSync(pasta);
      if (arquivos.some((arquivo) => arquivo.toLowerCase() === alvo)) return path.join(pasta, nomeExecutavel(ferramenta));
    } catch {
      // ignora pasta inacessivel do PATH
    }
  }
  return null;
}

/**
 * Descobre o caminho absoluto de um utilitario do PostgreSQL.
 * Prioridade: variavel de ambiente explicita > instalacao do Windows > PATH > comando nu (shell/PATH).
 */
function localizarFerramenta(ferramenta, variavelEnv) {
  const explicito = variavelEnv ? process.env[variavelEnv] : null;
  if (explicito) {
    if (existeExecutavel(explicito)) return { caminho: explicito, origem: variavelEnv };
    // Permite apenas o nome do executavel (ex.: PG_DUMP_PATH=pg_dump).
    if (!path.isAbsolute(explicito)) {
      const viaPath = procurarNoPath(explicito);
      if (viaPath) return { caminho: viaPath, origem: variavelEnv };
      return { caminho: explicito, origem: variavelEnv, resolvido: false };
    }
    return { caminho: explicito, origem: variavelEnv, resolvido: false };
  }
  for (const pasta of candidatosDoWindows()) {
    const candidato = path.join(pasta, nomeExecutavel(ferramenta));
    if (existeExecutavel(candidato)) return { caminho: candidato, origem: 'instalacao-windows' };
  }
  const viaPath = procurarNoPath(ferramenta);
  if (viaPath) return { caminho: viaPath, origem: 'path' };
  return { caminho: nomeExecutavel(ferramenta), origem: 'padrao', resolvido: false };
}

function obterFerramenta(ferramenta, variavelEnv) {
  const chave = `${ferramenta}:${variavelEnv || ''}`;
  if (!cache.has(chave)) cache.set(chave, localizarFerramenta(ferramenta, variavelEnv));
  return cache.get(chave);
}

const MAPA = {
  pg_dump: 'PG_DUMP_PATH',
  pg_restore: 'PG_RESTORE_PATH',
  psql: 'PSQL_PATH',
  pg_isready: 'PG_ISREADY_PATH',
  createdb: 'CREATEDB_PATH',
  dropdb: 'DROPDB_PATH'
};

/** Caminho do executavel, pronto para ser passado ao spawn. */
function caminhoFerramenta(ferramenta) {
  return obterFerramenta(ferramenta, MAPA[ferramenta]).caminho;
}

/** Argumentos comuns de host/porta/usuario para os utilitarios do PostgreSQL. */
function argumentosConexao() {
  const argumentos = [];
  if (process.env.DB_HOST) argumentos.push('--host', process.env.DB_HOST);
  if (process.env.DB_PORT) argumentos.push('--port', String(process.env.DB_PORT));
  if (process.env.DB_USER) argumentos.push('--username', process.env.DB_USER);
  return argumentos;
}

/**
 * Ambiente do processo filho. A senha viaja somente por PGPASSWORD (nunca em argumentos/logs).
 */
function ambienteFilho(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.env.DB_PASSWORD) env.PGPASSWORD = process.env.DB_PASSWORD;
  else delete env.PGPASSWORD;
  return env;
}

/** Diagnostico seguro para a interface: mostra caminhos e origem, nunca credenciais. */
function diagnostico() {
  const itens = FERRAMENTAS.map((ferramenta) => {
    const resolucao = obterFerramenta(ferramenta, MAPA[ferramenta]);
    return {
      ferramenta,
      variavel: MAPA[ferramenta],
      caminho: resolucao.caminho,
      origem: resolucao.origem,
      resolvido: existeExecutavel(resolucao.caminho)
    };
  });
  return {
    plataforma: process.platform,
    node: process.version,
    diretorios_inspecionados: process.platform === 'win32' ? DIRETORIOS_WINDOWS.filter(Boolean) : [],
    ferramentas: itens
  };
}

function definirCaminhoPadrao(ferramenta, destino) {
  if (!process.env[MAPA[ferramenta]] && destino) process.env[MAPA[ferramenta]] = destino;
  cache.delete(`${ferramenta}:${MAPA[ferramenta] || ''}`);
}

function limparCache() {
  cache.clear();
}

module.exports = {
  caminhoFerramenta,
  obterFerramenta,
  argumentosConexao,
  ambienteFilho,
  diagnostico,
  definirCaminhoPadrao,
  limparCache,
  existeExecutavel,
  pastaDoBinario,
  FERRAMENTAS
};