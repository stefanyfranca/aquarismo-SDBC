/**
 * Testes de validação de caminhos e nomes (injeção, path traversal, etc.).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validacao');

test('Nomes de banco válidos', () => {
  assert.equal(v.validarBanco('aquarismo'), null);
  assert.equal(v.validarBanco('_banco123'), null);
  assert.equal(v.validarBanco('Banco_X'), null);
});

test('Nomes de banco inválidos (injeção)', () => {
  assert.ok(v.validarBanco('banco; DROP TABLE'));
  assert.ok(v.validarBanco('banco`id`'));
  assert.ok(v.validarBanco('banco$(id)'));
  assert.ok(v.validarBanco('1banco')); // começa com número
  assert.ok(v.validarBanco(''));
  assert.ok(v.validarBanco(null));
});

test('Nomes de usuário válidos/inválidos', () => {
  assert.equal(v.validarUsuario('postgres'), null);
  assert.ok(v.validarUsuario('user;rm -rf /'));
  assert.ok(v.validarUsuario(''));
});

test('Hosts válidos e inválidos', () => {
  assert.equal(v.validarHost('127.0.0.1'), null);
  assert.equal(v.validarHost('localhost'), null);
  assert.equal(v.validarHost('meu-servidor.exemplo.com'), null);
  assert.ok(v.validarHost('999.999.999.999'));
  assert.ok(v.validarHost('host;rm -rf /'));
  assert.ok(v.validarHost(''));
  assert.ok(v.validarHost(null));
});

test('Portas válidas e inválidas', () => {
  assert.equal(v.validarPorta(5432), null);
  assert.equal(v.validarPorta(1), null);
  assert.equal(v.validarPorta(65535), null);
  assert.ok(v.validarPorta(0));
  assert.ok(v.validarPorta(65536));
  assert.ok(v.validarPorta('abc'));
  assert.ok(v.validarPorta(-1));
});

test('Caminhos com path traversal são rejeitados', () => {
  assert.ok(v.validarCaminho('C:\\backups\\..\\Windows'));
  assert.ok(v.validarCaminho('/backups/../etc'));
  assert.ok(v.validarCaminho('..\\backups'));
});

test('Caminhos com metacaracteres de shell são rejeitados', () => {
  for (const c of [';', '&', '|', '`', '$', '<', '>', '"', "'", '*', '?']) {
    assert.ok(v.validarCaminho(`C:\\backups${c}teste`), `deveria rejeitar "${c}"`);
  }
});

test('Caminhos relativos são rejeitados', () => {
  assert.ok(v.validarCaminho('backups'));
  assert.ok(v.validarCaminho('./backups'));
});

test('Caminhos absolutos válidos são aceitos', () => {
  if (process.platform === 'win32') {
    assert.equal(v.validarCaminho('C:\\backups'), null);
    assert.equal(v.validarCaminho('D:\\meus-backups\\sbac'), null);
  } else {
    assert.equal(v.validarCaminho('/backups'), null);
    assert.equal(v.validarCaminho('/var/backups/sbac'), null);
  }
});

test('Diretórios de sistema são rejeitados', () => {
  if (process.platform === 'win32') {
    assert.ok(v.validarCaminho('C:\\Windows\\backups'));
    assert.ok(v.validarCaminho('C:\\Program Files\\backups'));
  } else {
    assert.ok(v.validarCaminho('/etc/backups'));
    assert.ok(v.validarCaminho('/usr/backups'));
  }
});

test('Nomes reservados do Windows são rejeitados', () => {
  if (process.platform === 'win32') {
    assert.ok(v.validarCaminho('C:\\CON'));
    assert.ok(v.validarCaminho('C:\\NUL.txt'));
    assert.ok(v.validarCaminho('C:\\COM1'));
  }
});
