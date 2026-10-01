/**
 * Teste de integração com PostgreSQL local.
 * Pula automaticamente se não houver servidor disponível.
 * Requer: psql/pg_dump no PATH ou em C:\Program Files\PostgreSQL\*\bin.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PG_BIN = process.env.SBAC_PG_BIN ||
  (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '');

function pgOk() {
  try {
    const psql = path.join(PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql');
    execSync(`"${psql}" --version`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

const disponivel = pgOk();
const credenciais = {
  host: '127.0.0.1',
  porta: 5432,
  usuario: process.env.SBAC_PG_USER || 'sbac',
  senha: process.env.SBAC_PG_PASS || 'sbac123',
  banco: process.env.SBAC_PG_DB || 'sbac_vazio',
};

test('Integração: conexão, decisão e detecção de ferramentas', { skip: !disponivel }, async () => {
  const conexao = require('../src/conexao');
  const pgtools = require('../src/pgtools');

  // Ferramentas detectadas.
  const ferramentas = pgtools.localizarTodas(null);
  assert.ok(ferramentas.pg_dump, 'pg_dump deve ser encontrado');
  assert.ok(ferramentas.pg_restore, 'pg_restore deve ser encontrado');

  // Conexão funciona.
  await conexao.testarConexao(credenciais);

  // Permissões do usuário de teste (superuser no ambiente de teste).
  const pool = new (require('pg').Pool)({
    host: credenciais.host, port: credenciais.porta,
    user: credenciais.usuario, password: credenciais.senha,
    database: credenciais.banco, max: 1,
  });
  try {
    const perm = await conexao.verificarPermissoes({ ...credenciais, pool });
    assert.equal(perm.isSuper, true);
    assert.equal(perm.podeManter, true);
  } finally {
    await pool.end();
  }
});

test('Integração: pg_dump -Fc gera arquivo válido', { skip: !disponivel }, async () => {
  const pgtools = require('../src/pgtools');
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbac-it-'));
  try {
    const dump = pgtools.localizarFerramenta('pg_dump', null);
    const saida = path.join(dir, 't.dump');
    const r = spawnSync(dump.caminho, [
      '-Fc', '--no-password', '-h', credenciais.host, '-p', String(credenciais.porta),
      '-U', credenciais.usuario, '-d', credenciais.banco, '-f', saida,
    ], { env: { ...process.env, PGPASSWORD: credenciais.senha }, encoding: 'utf8' });
    assert.equal(r.status, 0, `pg_dump falhou: ${r.stderr}`);
    assert.ok(fs.existsSync(saida));
    assert.ok(fs.statSync(saida).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
