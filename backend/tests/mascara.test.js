/**
 * Testes de mascaramento de segredos em logs/saídas.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mascarar } = require('../src/lib/mascara');

test('Senha é mascarada em qualquer posição do texto', () => {
  const segredos = ['SenhaSecreta123'];
  assert.equal(
    mascarar('Conectando com password=SenhaSecreta123 no host', segredos),
    'Conectando com password=*** no host'
  );
  assert.equal(
    mascarar('SenhaSecreta123 aparece no início', segredos),
    '*** aparece no início'
  );
});

test('Múltiplos segredos são mascarados', () => {
  const segredos = ['senha-bd', 'chave-aes', 'senha-zip'];
  const texto = 'senha-bd e chave-aes e senha-zip';
  assert.equal(mascarar(texto, segredos), '*** e *** e ***');
});

test('Segredos vazios ou nulos não quebram', () => {
  assert.equal(mascarar('texto', []), 'texto');
  assert.equal(mascarar('texto', null), 'texto');
  assert.equal(mascarar(null, ['x']), '');
  assert.equal(mascarar(undefined, ['x']), '');
});

test('Segredo contendo caracteres de regex é tratado como literal', () => {
  const segredos = ['p@$$w0rd.*'];
  assert.equal(mascarar('senha=p@$$w0rd.* aqui', segredos), 'senha=*** aqui');
});

test('Máscara não deixa resíduos parciais', () => {
  const segredos = ['abcdefghij'];
  const saida = mascarar('xxabcdefghijyy abcdefghij zz', segredos);
  assert.ok(!saida.includes('abcdef'));
  assert.equal(saida, 'xx***yy *** zz');
});
