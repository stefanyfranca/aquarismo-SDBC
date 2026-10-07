/**
 * restauracao.test.js — Trilha de eventos (reenvio SSE) e leitura do
 * conteúdo do dump (`pg_restore -l`), que evita "restauração concluída"
 * sobre um backup vazio.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Restaurador, analisarToc } = require('../src/services/restauracao');

const SENHA = 'minha-senha-de-teste';

function novo() {
  return new Restaurador(
    { host: '127.0.0.1', porta: 5432, usuario: 'postgres', senha: SENHA },
    { arquivo: 'backup-x.dump', bancoDestino: 'x_restore', bancoOrigem: 'x' },
  );
}

test('historico registra os eventos para reenvio a clientes SSE tardios', () => {
  const r = novo();
  r.log('info', 'olá');
  r.emit('etapa', { etapa: 'criar', estado: 'executando' });
  r.emit('fim', { status: 'sucesso' });

  assert.deepEqual(r.historico.map(e => e.nome), ['log', 'etapa', 'fim']);
  assert.deepEqual(r.historico[2].dados, { status: 'sucesso' });

  // Eventos internos do EventEmitter não podem entrar na trilha.
  const antes = r.historico.length;
  r.once('log', () => {});
  r.removeAllListeners('log');
  assert.equal(r.historico.length, antes);
});

test('alertas ficam registrados e a mensagem de log mascara a senha', () => {
  const r = novo();
  r.alerta(`arquivo vazio, senha ${SENHA}`);

  assert.deepEqual(r.alertas, ['arquivo vazio, senha ***'], 'alerta exposto ao front deve vir mascarado');
  const msg = r.historico.at(-1).dados.mensagem;
  assert.ok(!msg.includes(SENHA), 'a senha não pode aparecer no log');
  assert.ok(msg.includes('***'), 'o segredo deve virar ***');
});

test('analisarToc: dump sem nenhuma entrada é vazio', () => {
  const r = analisarToc('; Archive created at 2026-10-07\n;\n; Selected TOC Entries:\n;\n');
  assert.equal(r.vazio, true);
  assert.equal(r.entradas, 0);
  assert.equal(r.tabelas, 0);
  assert.equal(r.comDados, 0);
});

test('analisarToc: conta tabelas e tabelas com dados copiados', () => {
  const r = analisarToc([
    '; header',
    '2000; 1259 16384 TABLE public clientes postgres',
    '2001; 1259 16419 TABLE DATA public clientes postgres',
    '2002; 1259 16420 TABLE DATA public pedidos postgres',
    '2003; 1259 16421 INDEX public pedidos_pkey postgres',
  ].join('\n'));

  assert.equal(r.vazio, false);
  assert.equal(r.entradas, 4);
  assert.equal(r.tabelas, 1, 'TABLE DATA não pode contar como TABLE');
  assert.equal(r.comDados, 2);
});

/** Pool falso: devolve o catálogo e as contagens/hashes do cenário do teste. */
function poolFake(tabelas) {
  const mapa = new Map(tabelas.map(t => [`${t.schema}.${t.tabela}`, t]));
  return {
    async query(sql) {
      if (sql.includes('FROM pg_class')) {
        return { rows: tabelas.map(t => ({ schema: t.schema, tabela: t.tabela })) };
      }
      const m = sql.match(/FROM "([^"]+)"\."([^"]+)"/);
      if (!m) throw new Error(`SQL não previsto: ${sql}`);
      const t = mapa.get(`${m[1]}.${m[2]}`);
      if (!t) throw new Error(`tabela inexistente: ${m[1]}.${m[2]}`);
      if (sql.includes('md5(')) return { rows: [{ h: t.hash }] };
      return { rows: [{ n: String(t.linhas) }] };
    },
    async end() {},
  };
}

test('integridade: origem e destino sem tabelas NÃO passam como idênticos', async () => {
  const r = novo();
  r.alerta('O arquivo de backup está vazio (sem tabelas nem dados).');
  r.criarPool = () => poolFake([]);

  const res = await r.conferirIntegridade('x', 'x_restore', false);

  assert.equal(res.tabelas.length, 0);
  assert.notEqual(res.veredito, 'Todas as tabelas idênticas entre origem e restaurado.');
  assert.ok(res.alertas.some(a => /Nenhuma tabela/.test(a)), 'esperava alerta de origem sem tabelas');
  assert.ok(res.alertas.some(a => /vazio/.test(a)), 'o alerta do dump vazio deve chegar à tela');
});

test('integridade: tabela ausente no restaurado conta como divergência', async () => {
  const r = novo();
  r.criarPool = (banco) => banco === 'x'
    ? poolFake([
        { schema: 'public', tabela: 'clientes', linhas: 10, hash: 'aaa' },
        { schema: 'public', tabela: 'pedidos', linhas: 5, hash: 'bbb' },
      ])
    : poolFake([{ schema: 'public', tabela: 'clientes', linhas: 10, hash: 'aaa' }]);

  const res = await r.conferirIntegridade('x', 'x_restore', false);

  assert.deepEqual(res.resumo, { origem: 2, restaurado: 1, divergentes: 1 });
  const linha = res.tabelas.find(t => t.tabela === 'public.pedidos');
  assert.equal(linha.status, 'ausente');
  assert.equal(linha.restaurado, 0);
  assert.ok(res.alertas.some(a => /1 tabela\(s\) do backup não foram restauradas/.test(a)));
  assert.ok(res.veredito.includes('1 tabela(s) divergente(s)'));
});

test('integridade: contagem e hash iguais dão veredito idêntico sem alertas', async () => {
  const r = novo();
  const tabelas = [{ schema: 'public', tabela: 'clientes', linhas: 10, hash: 'aaa' }];
  r.criarPool = () => poolFake(tabelas);

  const res = await r.conferirIntegridade('x', 'x_restore', false);

  assert.deepEqual(res.alertas, []);
  assert.equal(res.tabelas[0].status, 'identico');
  assert.equal(res.veredito, 'Todas as tabelas idênticas entre origem e restaurado.');
  assert.deepEqual(res.resumo, { origem: 1, restaurado: 1, divergentes: 0 });
});
