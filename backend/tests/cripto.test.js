/**
 * Testes de criptografia AES-256-GCM (ida e volta) e formato do arquivo.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cripto = require('../src/services/criptografia');

function dirTemporario() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbac-cripto-'));
}

test('Criptografia ida-e-volta preserva o conteúdo', async () => {
  const dir = dirTemporario();
  try {
    const original = path.join(dir, 'dump');
    const conteudo = Buffer.alloc(1024 * 1024); // 1 MB de dados aleatórios
    require('crypto').randomFillSync(conteudo);
    fs.writeFileSync(original, conteudo);

    const chave = 'minha-chave-secreta-123';
    const cifrado = await cripto.criptografarArquivo(original, chave);

    // Formato: salt(16) + iv(12) + tag(16) + dados
    const st = fs.statSync(cifrado);
    assert.ok(st.size >= conteudo.length + 44, 'arquivo cifrado deve ser pelo menos o original + cabeçalho');
    assert.ok(cifrado.endsWith('.enc'));

    // O arquivo em claro é removido.
    assert.ok(!fs.existsSync(original));

    const decifrado = path.join(dir, 'dump.decifrado');
    await cripto.descriptografarArquivo(cifrado, chave, decifrado);
    assert.deepEqual(fs.readFileSync(decifrado), conteudo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Chave incorreta falha ao descriptografar', async () => {
  const dir = dirTemporario();
  try {
    const original = path.join(dir, 'dump');
    fs.writeFileSync(original, 'dados secretos');
    const cifrado = await cripto.criptografarArquivo(original, 'chave-correta');
    await assert.rejects(
      cripto.descriptografarArquivo(cifrado, 'chave-errada', path.join(dir, 'saida')),
      /chave incorreta ou arquivo corrompido/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Salt aleatório: dois arquivos com a mesma chave geram ciphertexts diferentes', async () => {
  const dir = dirTemporario();
  try {
    const a1 = path.join(dir, 'a1');
    const a2 = path.join(dir, 'a2');
    fs.writeFileSync(a1, 'mesmo conteudo');
    fs.writeFileSync(a2, 'mesmo conteudo');
    const c1 = await cripto.criptografarArquivo(a1, 'chave');
    const c2 = await cripto.criptografarArquivo(a2, 'chave');
    assert.notEqual(fs.readFileSync(c1).toString('hex'), fs.readFileSync(c2).toString('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
