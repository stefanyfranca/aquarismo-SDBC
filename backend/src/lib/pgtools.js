/**
 * pgtools.js — Detecção e validação das ferramentas do PostgreSQL.
 *
 * No Windows as ferramentas frequentemente NÃO estão no PATH. Ordem de
 * busca: (1) PATH, (2) C:\Program Files\PostgreSQL\*\bin,
 * (3) locais comuns no Linux/macOS, (4) pasta informada pelo usuário
 * nas Configurações. Também detecta incompatibilidade de versão entre
 * pg_dump e o servidor.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCAIS_COMUNS = {
  win32: [
    'C:\\Program Files\\PostgreSQL',
    'C:\\Program Files (x86)\\PostgreSQL',
  ],
  darwin: [
    '/Applications/Postgres.app/Contents/Versions',
    '/usr/local/opt/libpq/bin',
    '/opt/homebrew/opt/libpq/bin',
    '/Library/PostgreSQL',
  ],
  linux: [
    '/usr/lib/postgresql',
    '/usr/pgsql',
    '/usr/local/pgsql',
  ],
};

function exe(nome) {
  return process.platform === 'win32' ? `${nome}.exe` : nome;
}

/** Lista candidatos a pastas bin, incluindo subpastas de versão. */
function candidatosBin(pastaBinUsuario) {
  const lista = [];
  if (pastaBinUsuario) lista.push(pastaBinUsuario);
  for (const base of LOCAIS_COMUNS[process.platform] || []) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const item of fs.readdirSync(base)) {
        const sub = path.join(base, item, 'bin');
        if (fs.existsSync(sub)) lista.push(sub);
      }
    } catch { /* sem permissão de leitura */ }
  }
  return lista;
}

/**
 * Localiza uma ferramenta do PostgreSQL.
 * @returns {{caminho: string, origem: 'PATH'|'padrao'|'usuario'}|null}
 */
function localizarFerramenta(nome, pastaBinUsuario) {
  const alvo = exe(nome);
  // 1) PATH
  const noPath = spawnSync(alvo, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (noPath.status === 0 && noPath.stdout) {
    return { caminho: alvo, origem: 'PATH', versao: noPath.stdout.trim() };
  }
  // 2) pastas padrão / 3) pasta do usuário
  for (const dir of candidatosBin(pastaBinUsuario)) {
    const cand = path.join(dir, alvo);
    if (fs.existsSync(cand)) {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 10000 });
      if (r.status === 0 && r.stdout) {
        return { caminho: cand, origem: pastaBinUsuario && dir === pastaBinUsuario ? 'usuario' : 'padrao', versao: r.stdout.trim() };
      }
    }
  }
  return null;
}

function localizarTodas(pastaBinUsuario) {
  return {
    pg_dump: localizarFerramenta('pg_dump', pastaBinUsuario),
    pg_restore: localizarFerramenta('pg_restore', pastaBinUsuario),
    psql: localizarFerramenta('psql', pastaBinUsuario),
  };
}

/** Extrai a versão principal (ex.: 18) de "pg_dump (PostgreSQL) 18.1". */
function versaoPrincipal(textoVersao) {
  const m = /(\d+)/.exec(textoVersao || '');
  return m ? Number(m[1]) : null;
}

/**
 * Verifica compatibilidade entre pg_dump e o servidor.
 * Regra prática: mesma versão principal, ou pg_dump >= servidor.
 */
function verificarCompatibilidade(versaoPgDump, versaoServidor) {
  const a = versaoPrincipal(versaoPgDump);
  const b = versaoPrincipal(versaoServidor);
  if (!a || !b) return { ok: true, aviso: null };
  if (a === b) return { ok: true, aviso: null };
  if (a > b) return { ok: true, aviso: `pg_dump ${a} é mais novo que o servidor ${b}; funcionará, mas considere atualizar as ferramentas.` };
  return {
    ok: false,
    erro: `Incompatibilidade de versão: pg_dump ${a} é mais antigo que o servidor PostgreSQL ${b}. ` +
      `Atualize as ferramentas do PostgreSQL (pasta bin) ou use um pg_dump da mesma versão do servidor.`,
  };
}

module.exports = { localizarFerramenta, localizarTodas, versaoPrincipal, verificarCompatibilidade };
