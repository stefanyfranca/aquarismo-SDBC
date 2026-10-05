/**
 * zip.test.js — ZIP protegido por senha (WinZip AES-256).
 *
 * Cobre a etapa de compactação do pipeline e a leitura de volta pelo módulo
 * próprio (zipaes), incluindo a preservação do nome interno (.dump/.dump.enc).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Executor } = require('../src/services/pipeline');
const { Restaurador } = require('../src/services/restauracao');
const zipaes = require('../src/services/zipaes');
const db = require('../src/lib/db');

// O pipeline grava log no banco local; aqui só importa o ZIP, então neutraliza.
db.inserirLog = () => {};

const SENHA = 'senha-de-teste-123';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbac-zip-'));
}

/** Gera um ZIP pelo próprio pipeline (etapa 5) a partir de um dump fictício. */
async function compactar(dir, { nomeBase, dump = 'backup-teste.dump', senha = SENHA } = {}) {
  const dumpPath = path.join(dir, dump);
  fs.writeFileSync(dumpPath, 'PGDMP-ficticio-conteudo-do-dump');
  const ex = new Executor({}, { banco: 'teste', senhaZip: senha, compactar: true });
  ex.arquivoAtual = dumpPath;
  ex.nomeBase = nomeBase || path.basename(dump, '.dump');
  await ex.etapaCompactacao();
  return ex.arquivoAtual;
}

test('compactação gera ZIP AES-256 com nome final sem .dump e sem texto claro', async () => {
  const dir = tempDir();
  const zip = await compactar(dir, { nomeBase: 'backup-teste-2026-10-05-00-00-00' });

  assert.equal(path.basename(zip), 'backup-teste-2026-10-05-00-00-00.zip');
  assert.ok(!zip.includes('.dump.zip'), 'nome final não deve conter ".dump.zip"');
  assert.ok(fs.existsSync(zip));
  assert.ok(!fs.existsSync(path.join(dir, 'backup-teste.dump')), 'dump intermediário deve ser removido');

  const buf = fs.readFileSync(zip);
  assert.ok(!buf.includes(Buffer.from('PGDMP')), 'o dump não pode aparecer em claro no ZIP');
  assert.ok(!buf.includes(Buffer.from('ficticio')), 'conteúdo não pode aparecer em claro no ZIP');
});

test('ZIP cifrado só abre com a senha correta', async () => {
  const dir = tempDir();
  const zip = await compactar(dir);
  const buf = fs.readFileSync(zip);

  const conteudo = zipaes.descompactarZipAes(buf, SENHA).toString();
  assert.equal(conteudo, 'PGDMP-ficticio-conteudo-do-dump');

  assert.throws(() => zipaes.descompactarZipAes(buf, 'senha-errada'));
  assert.throws(() => zipaes.descompactarZipAes(buf, ''));
});

test('restauração preserva o nome interno do ZIP (.dump e .dump.enc)', async () => {
  const dir = tempDir();

  for (const interno of ['backup-x-2026-10-05.dump', 'backup-x-2026-10-05.dump.enc']) {
    const zip = await compactar(dir, { nomeBase: 'backup-x-2026-10-05', dump: interno });
    assert.equal(zipaes.nomeDaEntrada(fs.readFileSync(zip)), interno);

    const saida = tempDir();
    const nome = new Restaurador({ senha: 'x' }, {}).descompactarZip(zip, saida, SENHA);
    assert.equal(nome, interno, 'o nome interno indica se ainda falta desfazer a camada AES');
    assert.equal(fs.readFileSync(path.join(saida, nome)).toString(), 'PGDMP-ficticio-conteudo-do-dump');
  }
});