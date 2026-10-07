/**
 * db.js — Armazenamento local de metadados da plataforma (FORA do banco-alvo).
 *
 * Usa SQLite via node:sqlite (builtin do Node 22+). Nenhum dado de conexão
 * sensível (usuário/senha do banco) é gravado: apenas a chave host:porta/banco.
 * Único segredo persistido: a senha SMTP de alerta (coluna smtp_senha), que
 * vive só em data/ (fora do repositório) e nunca é devolvida pela API.
 * Em inicializações, execuções "em andamento" (queda do servidor) são
 * marcadas como falha com mensagem explicativa.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// data/ fica na raiz do projeto (fora do código), compartilhado por todos os módulos.
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
const DB_PATH = path.join(DATA_DIR, 'sbac.sqlite');

let db = null;

function garantirDirs() {
  for (const d of [DATA_DIR, LOGS_DIR, OUTBOX_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function init() {
  garantirDirs();
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS execucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_conexao TEXT NOT NULL,
      inicio TEXT NOT NULL,
      fim TEXT,
      status TEXT NOT NULL CHECK (status IN ('andamento','sucesso','falha')),
      manutencao_tipo TEXT,
      regra_aplicada TEXT,
      origem_decisao TEXT CHECK (origem_decisao IN ('automatica','explicita','simulada')),
      resultado TEXT,
      arquivo_final TEXT,
      etapa_falha TEXT,
      parametros TEXT NOT NULL DEFAULT '{}',
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS manutencoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave_conexao TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('VACUUM','VACUUM_FULL_ANALYZE')),
      inicio TEXT NOT NULL,
      fim TEXT,
      execucao_id INTEGER REFERENCES execucoes(id)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execucao_id INTEGER NOT NULL REFERENCES execucoes(id),
      data TEXT NOT NULL,
      etapa TEXT NOT NULL,
      nivel TEXT NOT NULL CHECK (nivel IN ('info','aviso','erro','depuracao')),
      mensagem TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave_conexao TEXT PRIMARY KEY,
      destino TEXT,
      quantidade_manter INTEGER,
      copia_adicional TEXT,
      compactar INTEGER NOT NULL DEFAULT 0,
      criptografar INTEGER NOT NULL DEFAULT 0,
      pasta_bin TEXT,
      email_alerta TEXT,
      smtp_host TEXT,
      smtp_porta INTEGER,
      smtp_usuario TEXT,
      smtp_senha TEXT,
      demo_ativo INTEGER NOT NULL DEFAULT 0,
      demo_data_manutencao TEXT,
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_execucoes_chave ON execucoes(chave_conexao);
    CREATE INDEX IF NOT EXISTS idx_logs_execucao ON logs(execucao_id);
  `);

  // Migração de esquema: bancos criados antes da coluna smtp_senha.
  const colunas = db.prepare('PRAGMA table_info(configuracoes)').all().map(c => c.name);
  if (!colunas.includes('smtp_senha')) {
    db.exec('ALTER TABLE configuracoes ADD COLUMN smtp_senha TEXT');
  }

  // Recuperação de queda: execuções que ficaram "em andamento" viram falha.
  const marcadas = db.prepare(
    `UPDATE execucoes SET status='falha', fim=COALESCE(fim, datetime('now')),
       etapa_falha='finalizacao', resultado='Execução interrompida por queda/reinício do servidor.'
     WHERE status='andamento'`
  ).run();
  if (marcadas.changes > 0) {
    console.log(`[db] ${marcadas.changes} execução(ões) em andamento marcadas como falha (queda do servidor).`);
  }
  return db;
}

function get() {
  if (!db) throw new Error('Banco local não inicializado. Chame init() antes.');
  return db;
}

/* ------------------------------ execuções ------------------------------ */

function inserirExecucao(e) {
  const r = get().prepare(
    `INSERT INTO execucoes (chave_conexao, inicio, status, manutencao_tipo, regra_aplicada,
       origem_decisao, resultado, arquivo_final, etapa_falha, parametros)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(e.chave_conexao, e.inicio, e.status || 'andamento', e.manutencao_tipo || null,
    e.regra_aplicada || null, e.origem_decisao || null, e.resultado || null,
    e.arquivo_final || null, e.etapa_falha || null, JSON.stringify(e.parametros || {}));
  return Number(r.lastInsertRowid);
}

function atualizarExecucao(id, campos) {
  const colunas = Object.keys(campos);
  if (colunas.length === 0) return;
  const sets = colunas.map(c => `${c} = ?`).join(', ');
  const valores = colunas.map(c => (c === 'parametros' ? JSON.stringify(campos[c]) : campos[c]));
  get().prepare(`UPDATE execucoes SET ${sets} WHERE id = ?`).run(...valores, id);
}

function buscarExecucao(id) {
  const row = get().prepare('SELECT * FROM execucoes WHERE id = ?').get(id);
  if (row) row.parametros = JSON.parse(row.parametros || '{}');
  return row;
}

function listarExecucoes({ status, dias, chave } = {}) {
  let sql = 'SELECT * FROM execucoes WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (chave) { sql += ' AND chave_conexao = ?'; params.push(chave); }
  if (dias) { sql += " AND inicio >= datetime('now', ?)"; params.push(`-${dias} days`); }
  sql += ' ORDER BY inicio DESC';
  const rows = get().prepare(sql).all(...params);
  for (const r of rows) r.parametros = JSON.parse(r.parametros || '{}');
  return rows;
}

/* ----------------------------- manutenções ----------------------------- */

function inserirManutencao(m) {
  const r = get().prepare(
    'INSERT INTO manutencoes (chave_conexao, tipo, inicio, fim, execucao_id) VALUES (?,?,?,?,?)'
  ).run(m.chave_conexao, m.tipo, m.inicio, m.fim, m.execucao_id || null);
  return Number(r.lastInsertRowid);
}

function ultimaManutencao(chaveConexao) {
  return get().prepare(
    'SELECT * FROM manutencoes WHERE chave_conexao = ? ORDER BY fim DESC LIMIT 1'
  ).get(chaveConexao) || null;
}

/* -------------------------------- logs --------------------------------- */

function inserirLog(l) {
  const r = get().prepare(
    'INSERT INTO logs (execucao_id, data, etapa, nivel, mensagem) VALUES (?,?,?,?,?)'
  ).run(l.execucao_id, l.data, l.etapa, l.nivel, l.mensagem);
  // Espelha em arquivo data/logs/execucao-N.log
  try {
    const linha = `${l.data} [${l.nivel.toUpperCase()}] [${l.etapa}] ${l.mensagem}\n`;
    fs.appendFileSync(path.join(LOGS_DIR, `execucao-${l.execucao_id}.log`), linha);
  } catch { /* falha de espelho não quebra a execução */ }
  return Number(r.lastInsertRowid);
}

function listarLogs({ execucao_id, nivel, limite = 500 } = {}) {
  let sql = 'SELECT * FROM logs WHERE 1=1';
  const params = [];
  if (execucao_id) { sql += ' AND execucao_id = ?'; params.push(execucao_id); }
  if (nivel) { sql += ' AND nivel = ?'; params.push(nivel); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limite);
  return get().prepare(sql).all(...params);
}

function logsDaExecucao(execucaoId) {
  return get().prepare(
    'SELECT * FROM logs WHERE execucao_id = ? ORDER BY id ASC'
  ).all(execucaoId);
}

/* ---------------------------- configurações ---------------------------- */

function getConfiguracao(chaveConexao) {
  return get().prepare('SELECT * FROM configuracoes WHERE chave_conexao = ?').get(chaveConexao) || null;
}

function salvarConfiguracao(c) {
  const agora = new Date().toISOString();
  // smtp_senha ausente (undefined) preserva a senha já gravada; string vazia limpa.
  const senha = c.smtp_senha === undefined
    ? (get().prepare('SELECT smtp_senha FROM configuracoes WHERE chave_conexao = ?')
        .get(c.chave_conexao)?.smtp_senha ?? null)
    : (c.smtp_senha || null);
  get().prepare(`
    INSERT INTO configuracoes (chave_conexao, destino, quantidade_manter, copia_adicional,
      compactar, criptografar, pasta_bin, email_alerta, smtp_host, smtp_porta, smtp_usuario,
      smtp_senha, demo_ativo, demo_data_manutencao, atualizado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chave_conexao) DO UPDATE SET
      destino=excluded.destino, quantidade_manter=excluded.quantidade_manter,
      copia_adicional=excluded.copia_adicional, compactar=excluded.compactar,
      criptografar=excluded.criptografar, pasta_bin=excluded.pasta_bin,
      email_alerta=excluded.email_alerta, smtp_host=excluded.smtp_host,
      smtp_porta=excluded.smtp_porta, smtp_usuario=excluded.smtp_usuario,
      smtp_senha=excluded.smtp_senha,
      demo_ativo=excluded.demo_ativo, demo_data_manutencao=excluded.demo_data_manutencao,
      atualizado_em=excluded.atualizado_em
  `).run(c.chave_conexao, c.destino || null, c.quantidade_manter ?? null,
    c.copia_adicional || null, c.compactar ? 1 : 0, c.criptografar ? 1 : 0,
    c.pasta_bin || null, c.email_alerta || null, c.smtp_host || null,
    c.smtp_porta ?? null, c.smtp_usuario || null, senha, c.demo_ativo ? 1 : 0,
    c.demo_data_manutencao || null, agora);
}

module.exports = {
  init, get, DATA_DIR, LOGS_DIR, OUTBOX_DIR, DB_PATH,
  inserirExecucao, atualizarExecucao, buscarExecucao, listarExecucoes,
  inserirManutencao, ultimaManutencao,
  inserirLog, listarLogs, logsDaExecucao,
  getConfiguracao, salvarConfiguracao,
};
