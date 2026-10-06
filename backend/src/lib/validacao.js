/**
 * validacao.js — Validação de entradas (nomes, portas, caminhos).
 *
 * Regras:
 * - Banco/usuário: regex restritiva [A-Za-z0-9_], início com letra/underscore.
 * - Host: hostname válido ou IPv4.
 * - Porta: inteira 1–65535.
 * - Caminhos: absolutos, normalizados, sem '..', sem caracteres de controle
 *   nem metacaracteres de shell, sem nomes reservados do Windows e nunca
 *   dentro de diretórios de sistema.
 */
const path = require('path');

const RE_BANCO = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const RE_USUARIO = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const RE_HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const RE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Caracteres proibidos em caminhos: controle, metacaracteres de shell e aspas.
const RE_CAMINHO_PROIBIDO = /[;&|`$<>"'*?\x00-\x1f]/;

// Diretórios de sistema onde NUNCA se deve gravar backups.
const PREFIXOS_SISTEMA_WIN = [
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata',
  'c:\\system volume information', 'c:\\$recycle.bin', 'c:\\boot',
];
const PREFIXOS_SISTEMA_UNIX = [
  '/etc', '/bin', '/sbin', '/usr', '/sys', '/proc', '/dev', '/lib', '/lib64', '/boot',
];

function validarBanco(nome) {
  if (!nome || !RE_BANCO.test(nome)) {
    return 'Nome de banco inválido. Use apenas letras, números, "_" ou "$", começando com letra ou "_".';
  }
  return null;
}

function validarUsuario(nome) {
  if (!nome || !RE_USUARIO.test(nome)) {
    return 'Nome de usuário inválido. Use apenas letras, números, "_" ou "$", começando com letra ou "_".';
  }
  return null;
}

function validarHost(host) {
  if (!host || typeof host !== 'string') return 'Host é obrigatório.';
  const h = host.trim();
  if (h.length > 253) return 'Host muito longo.';
  if (RE_IPV4.test(h)) {
    const partes = h.split('.').map(Number);
    if (partes.every(p => p >= 0 && p <= 255)) return null;
    return 'Endereço IPv4 inválido.';
  }
  if (RE_HOST.test(h)) return null;
  return 'Host inválido. Informe um hostname ou endereço IPv4 válido.';
}

function validarPorta(porta) {
  const n = Number(porta);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return 'Porta inválida. Informe um inteiro entre 1 e 65535.';
  }
  return null;
}

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Valida um caminho de diretório de destino.
 * @returns {string|null} mensagem de erro, ou null se válido.
 */
function validarCaminho(caminho, { rotulo = 'Caminho' } = {}) {
  if (!caminho || typeof caminho !== 'string' || !caminho.trim()) {
    return `${rotulo} é obrigatório.`;
  }
  const c = caminho.trim();
  if (RE_CAMINHO_PROIBIDO.test(c)) {
    return `${rotulo} contém caracteres proibidos (metacaracteres de shell, aspas ou controle).`;
  }
  if (!path.isAbsolute(c)) {
    return `${rotulo} deve ser um caminho absoluto.`;
  }
  let abs;
  try {
    abs = path.resolve(c);
  } catch {
    return `${rotulo} inválido.`;
  }
  const norm = path.normalize(abs);
  // Verifica ".." como componente do caminho (normalização pode escondê-lo).
  const sep = path.sep;
  if (c.split(/[\\/]/).includes('..') || norm.split(/[\\/]/).includes('..')) {
    return `${rotulo} não pode conter "..".`;
  }
  // Nomes reservados do Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
  if (isWindows()) {
    const base = path.basename(norm).toLowerCase().split('.')[0];
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base)) {
      return `${rotulo} usa nome reservado do Windows ("${base}").`;
    }
    const lower = norm.toLowerCase();
    for (const p of PREFIXOS_SISTEMA_WIN) {
      if (lower === p || lower.startsWith(p + '\\')) {
        return `${rotulo} aponta para um diretório do sistema (${p}). Escolha outro local.`;
      }
    }
  } else {
    const lower = norm.toLowerCase();
    for (const p of PREFIXOS_SISTEMA_UNIX) {
      if (lower === p || lower.startsWith(p + '/')) {
        return `${rotulo} aponta para um diretório do sistema (${p}). Escolha outro local.`;
      }
    }
  }
  return null;
}

/**
 * Verifica se o diretório já existe.
 * @returns {string|null} erro ou null.
 */
function verificarDiretorioExiste(dir, { rotulo = 'Diretório' } = {}) {
  const fs = require('fs');
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) {
    return `${rotulo} "${abs}" não existe. Confira o caminho ou marque a criação automática.`;
  }
  if (!fs.statSync(abs).isDirectory()) {
    return `${rotulo} "${abs}" não é um diretório.`;
  }
  return null;
}

/**
 * Verifica se um diretório existe e é gravável (tenta criar arquivo temporário).
 * Com `criar: false`, um diretório inexistente é erro em vez de ser criado —
 * evita transformar um caminho digitado errado em uma pasta nova.
 * @returns {Promise<string|null>} erro ou null.
 */
async function verificarDiretorioGravavel(dir, { criar = true, rotulo = 'Diretório' } = {}) {
  const fs = require('fs');
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) {
    if (!criar) return verificarDiretorioExiste(abs, { rotulo });
    try {
      await fs.promises.mkdir(abs, { recursive: true });
    } catch (e) {
      return `Não foi possível criar o diretório "${abs}": ${e.message}`;
    }
  }
  const teste = path.join(abs, `.sbac-test-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(teste, 'ok');
    await fs.promises.unlink(teste);
  } catch (e) {
    return `Diretório "${abs}" não tem permissão de escrita: ${e.message}`;
  }
  return null;
}

/**
 * Verifica espaço livre razoável no diretório (mínimo 100 MB).
 */
async function verificarEspacoLivre(dir, minimoMB = 100) {
  const fs = require('fs');
  try {
    const stats = await fs.promises.statfs(dir);
    const livreMB = (stats.bavail * stats.bsize) / (1024 * 1024);
    if (livreMB < minimoMB) {
      return `Espaço livre insuficiente em "${dir}": ${Math.round(livreMB)} MB (mínimo ${minimoMB} MB).`;
    }
    return null;
  } catch {
    // statfs indisponível (ex.: alguns Windows) — não bloqueia.
    return null;
  }
}

module.exports = {
  validarBanco, validarUsuario, validarHost, validarPorta,
  validarCaminho, verificarDiretorioExiste, verificarDiretorioGravavel, verificarEspacoLivre, isWindows,
};
