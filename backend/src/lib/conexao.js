/**
 * conexao.js — Gerenciamento de conexões PostgreSQL por sessão.
 *
 * O pool é criado por sessão (a senha vive só na memória da sessão) e
 * fechado ao desconectar. Inclui: teste de conexão, listagem de bancos,
 * healthcheck real (SELECT 1) e verificação de permissões para VACUUM
 * e pg_dump.
 */
const { Pool } = require('pg');
const db = require('./db');

/**
 * Cria (ou recria) o pool da sessão para um banco específico.
 */
function conectar(sessao, banco) {
  if (sessao.pool) {
    sessao.pool.end().catch(() => {});
    sessao.pool = null;
  }
  sessao.pool = new Pool({
    host: sessao.host,
    port: sessao.porta,
    user: sessao.usuario,
    password: sessao.senha, // nunca sai da memória nem vai para argumentos de comando
    database: banco,
    ssl: sessao.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 60000,
  });
  sessao.banco = banco;
  return sessao.pool;
}

/**
 * Testa a conexão. Lança Error com mensagem clara em português.
 */
async function testarConexao({ host, porta, usuario, senha, banco, ssl }) {
  const pool = new Pool({
    host, port: Number(porta), user: usuario, password: senha,
    database: banco || 'postgres',
    ssl: ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    max: 1,
  });
  try {
    const r = await pool.query('SELECT 1 AS ok');
    if (!r.rows[0].ok) throw new Error('Resposta inesperada do servidor.');
    return true;
  } catch (e) {
    throw traduzirErro(e);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Traduz erros do pg para mensagens claras em português, sem vazar segredos. */
function traduzirErro(e) {
  const msg = String(e.message || e);
  if (/password authentication failed/i.test(msg)) {
    return new Error('Senha incorreta para o usuário informado.');
  }
  if (/database ".*" does not exist/i.test(msg)) {
    return new Error('Banco de dados inexistente.');
  }
  if (/could not connect|ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) {
    return new Error('Host inacessível. Verifique o host, a porta e se o servidor está rodando.');
  }
  if (/no pg_hba.conf entry/i.test(msg)) {
    return new Error('Conexão recusada pelo servidor (pg_hba.conf). Verifique as permissões de acesso.');
  }
  if (/permission denied/i.test(msg)) {
    return new Error('Sem permissão: ' + msg);
  }
  // Remove qualquer senha que possa ter vazado na mensagem.
  return new Error(msg.replace(/password=\S+/gi, 'password=***'));
}

/** Lista bancos conectáveis (conforme enunciado). */
async function listarBancos(sessao) {
  const pool = sessao.pool || conectar(sessao, sessao.banco || 'postgres');
  const r = await pool.query(
    'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname'
  );
  return r.rows.map(x => x.datname);
}

/** Healthcheck real: SELECT 1. */
async function healthcheck(sessao) {
  const pool = sessao.pool || conectar(sessao, sessao.banco || 'postgres');
  const r = await pool.query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}

/**
 * Verifica permissões do usuário para manutenção (VACUUM) e backup.
 * Regras: superusuário, dono do banco, ou (PG17+) privilégio pg_maintain.
 * Para pg_dump: precisa de SELECT nas tabelas.
 */
async function verificarPermissoes(sessao) {
  const pool = sessao.pool || conectar(sessao, sessao.banco || 'postgres');
  const erros = [];

  // Superusuário?
  const su = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  const isSuper = su.rows[0]?.rolsuper === true;

  // Versão do servidor
  const v = await pool.query('SHOW server_version');
  const versao = Number(String(v.rows[0].server_version).split('.')[0]);

  // Privilégio pg_maintain (PG17+)
  let temMaintain = false;
  if (versao >= 17) {
    const m = await pool.query(
      `SELECT pg_has_role(current_user, 'pg_maintain', 'MEMBER') AS tem`
    );
    temMaintain = m.rows[0]?.tem === true;
  }

  // Dono do banco?
  const dono = await pool.query(
    `SELECT pg_catalog.pg_get_userbyid(datdba) AS dono FROM pg_database WHERE datname = current_database()`
  );
  const isDono = dono.rows[0]?.dono === sessao.usuario;

  const podeManter = isSuper || temMaintain || isDono;
  if (!podeManter) {
    erros.push(
      `O usuário "${sessao.usuario}" não pode executar VACUUM: é necessário ser superusuário, ` +
      `dono do banco ou possuir o privilégio pg_maintain (PostgreSQL 17+).`
    );
  }

  // SELECT nas tabelas de usuário (necessário para pg_dump)
  const semSelect = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS tabela
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m')
      AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_%'
      AND NOT has_table_privilege(format('%I.%I', n.nspname, c.relname), 'SELECT')
    ORDER BY 1, 2
  `);
  if (semSelect.rows.length > 0) {
    const lista = semSelect.rows.slice(0, 5).map(r => `${r.schema}.${r.tabela}`).join(', ');
    erros.push(
      `Sem permissão de SELECT em ${semSelect.rows.length} tabela(s) (pg_dump pode falhar): ${lista}` +
      (semSelect.rows.length > 5 ? '…' : '')
    );
  }

  return { podeManter, isSuper, isDono, versao, tabelasSemSelect: semSelect.rows.length, erros };
}

/** Resumo do banco conectado: tamanho e nº de tabelas. */
async function resumoBanco(sessao) {
  const pool = sessao.pool || conectar(sessao, sessao.banco || 'postgres');
  const tamanho = await pool.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS tamanho,
            pg_database_size(current_database()) AS bytes`
  );
  const tabelas = await pool.query(
    `SELECT count(*) AS n FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_%'`
  );
  return {
    tamanho: tamanho.rows[0].tamanho,
    bytes: Number(tamanho.rows[0].bytes),
    tabelas: Number(tabelas.rows[0].n),
  };
}

/** Data da última manutenção pelas estatísticas do banco (Fonte B). */
async function ultimaManutencaoEstatisticas(sessao) {
  const pool = sessao.pool || conectar(sessao, sessao.banco || 'postgres');
  try {
    const r = await pool.query(
      'SELECT GREATEST(max(last_vacuum), max(last_analyze)) AS data FROM pg_stat_user_tables'
    );
    const d = r.rows[0]?.data;
    return d ? new Date(d) : null;
  } catch {
    return null;
  }
}

module.exports = {
  conectar, testarConexao, traduzirErro, listarBancos, healthcheck,
  verificarPermissoes, resumoBanco, ultimaManutencaoEstatisticas,
};
