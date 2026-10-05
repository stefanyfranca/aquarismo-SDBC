/**
 * Testes de retenção de backups.
 * Cenário: manter 2, criar 4 arquivos do padrão → restam 2.
 * Arquivos fora do padrão NUNCA são apagados.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const retencao = require('../src/retencao');

function dirTemporario() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbac-retencao-'));
}

function criarArquivo(dir, nome, diasAtras) {
  const full = path.join(dir, nome);
  fs.writeFileSync(full, 'x');
  const t = new Date(Date.now() - diasAtras * 86400000);
  fs.utimesSync(full, t, t);
}

test('Retenção mantém os N mais recentes do padrão', () => {
  const dir = dirTemporario();
  try {
    criarArquivo(dir, 'backup-teste-2026-01-01T10-00-00.dump', 4);
    criarArquivo(dir, 'backup-teste-2026-01-02T10-00-00.dump', 3);
    criarArquivo(dir, 'backup-teste-2026-01-03T10-00-00.dump', 2);
    criarArquivo(dir, 'backup-teste-2026-01-04T10-00-00.dump', 1);

    const r = retencao.aplicarRetencao(dir, 'teste', 2);
    assert.equal(r.mantidos.length, 2);
    assert.equal(r.removidos.length, 2);
    assert.ok(r.mantidos.includes('backup-teste-2026-01-04T10-00-00.dump'));
    assert.ok(r.mantidos.includes('backup-teste-2026-01-03T10-00-00.dump'));
    assert.ok(r.removidos.includes('backup-teste-2026-01-01T10-00-00.dump'));
    assert.ok(r.removidos.includes('backup-teste-2026-01-02T10-00-00.dump'));

    const restantes = fs.readdirSync(dir).sort();
    assert.deepEqual(restantes, [
      'backup-teste-2026-01-03T10-00-00.dump',
      'backup-teste-2026-01-04T10-00-00.dump',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Arquivos fora do padrão NUNCA são apagados', () => {
  const dir = dirTemporario();
  try {
    criarArquivo(dir, 'backup-teste-2026-01-01T10-00-00.dump', 2);
    criarArquivo(dir, 'backup-teste-2026-01-02T10-00-00.dump', 1);
    criarArquivo(dir, 'outro-arquivo.txt', 1); // fora do padrão

    const r = retencao.aplicarRetencao(dir, 'teste', 1);
    assert.equal(r.mantidos.length, 1);
    assert.equal(r.removidos.length, 1);
    // O arquivo fora do padrão continua existindo.
    assert.ok(fs.existsSync(path.join(dir, 'outro-arquivo.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Retenção com quantidade maior que o total não apaga nada', () => {
  const dir = dirTemporario();
  try {
    criarArquivo(dir, 'backup-teste-2026-01-01T10-00-00.dump', 2);
    criarArquivo(dir, 'backup-teste-2026-01-02T10-00-00.dump', 1);
    const r = retencao.aplicarRetencao(dir, 'teste', 10);
    assert.equal(r.removidos.length, 0);
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
