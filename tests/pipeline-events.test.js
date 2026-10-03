const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const email = require('../src/email');
const { Executor } = require('../src/pipeline');

test('fim é emitido somente depois de todos os logs da execução', async () => {
  mock.method(db, 'inserirExecucao', () => 1);
  mock.method(db, 'atualizarExecucao', () => {});
  mock.method(db, 'inserirLog', () => {});
  mock.method(db, 'buscarExecucao', () => ({ chave_conexao: 'localhost:5432/teste' }));
  mock.method(db, 'logsDaExecucao', () => []);
  mock.method(db, 'getConfiguracao', () => ({}));
  mock.method(email, 'enviarEmailExecucao', async () => ({
    enviado: false,
    motivo: 'Configuração SMTP ausente.',
  }));

  const executor = new Executor(
    { host: 'localhost', porta: 5432, senha: 'senha' },
    { banco: 'teste' },
    { tipo: 'NENHUMA', regra: 'teste', origem: 'explicita' },
  );
  executor.executarEtapa = async () => true;

  const eventos = [];
  executor.on('log', () => eventos.push('log'));
  executor.on('fim', () => eventos.push('fim'));

  await executor.executar();

  assert.equal(eventos.at(-1), 'fim');
  assert.equal(eventos.filter(evento => evento === 'fim').length, 1);
  assert.ok(eventos.slice(0, -1).includes('log'));
});
