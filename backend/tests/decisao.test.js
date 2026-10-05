/**
 * Testes da regra de decisão de manutenção.
 * Cenários: 11 dias, 29/30 dias, 60/61 dias, sem data, escolha explícita prevalecendo.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const db = require('../src/db');
const manutencao = require('../src/manutencao');

function dataHaDias(dias) {
  return new Date(Date.now() - dias * 86400000);
}

function decidirComFonteA(dataA, escolha = 'AUTOMATICA', opts = {}) {
  const m = mock.method(db, 'ultimaManutencao', () => dataA ? { fim: dataA.toISOString() } : null);
  try {
    return manutencao.decidir({
      chaveConexao: 'h:5432/b',
      escolhaExplicita: escolha,
      dataSimulada: opts.dataSimulada || null,
      demoAtivo: opts.demoAtivo || false,
      fonteB: opts.fonteB || null,
    });
  } finally {
    m.mock.restore();
  }
}

test('11 dias desde a última manutenção → NENHUMA (< 30)', () => {
  const d = decidirComFonteA(dataHaDias(11));
  assert.equal(d.tipo, 'NENHUMA');
  assert.match(d.regra, /Última manutenção há 11 dias \(< 30\)/);
  assert.equal(d.origem, 'automatica');
});

test('29 dias → NENHUMA (limite inferior)', () => {
  const d = decidirComFonteA(dataHaDias(29));
  assert.equal(d.tipo, 'NENHUMA');
});

test('30 dias → VACUUM (limite inclusivo)', () => {
  const d = decidirComFonteA(dataHaDias(30));
  assert.equal(d.tipo, 'VACUUM');
  assert.match(d.regra, /Última manutenção há 30 dias \(entre 30 e 60\)/);
});

test('43 dias → VACUUM', () => {
  const d = decidirComFonteA(dataHaDias(43));
  assert.equal(d.tipo, 'VACUUM');
});

test('60 dias → VACUUM (limite superior inclusivo)', () => {
  const d = decidirComFonteA(dataHaDias(60));
  assert.equal(d.tipo, 'VACUUM');
});

test('61 dias → VACUUM FULL ANALYZE', () => {
  const d = decidirComFonteA(dataHaDias(61));
  assert.equal(d.tipo, 'VACUUM_FULL_ANALYZE');
  assert.match(d.regra, /Última manutenção há 61 dias \(> 60\)/);
});

test('75 dias → VACUUM FULL ANALYZE', () => {
  const d = decidirComFonteA(dataHaDias(75));
  assert.equal(d.tipo, 'VACUUM_FULL_ANALYZE');
});

test('Sem histórico (fonte A nula e fonte B nula) → VACUUM FULL ANALYZE', () => {
  const d = decidirComFonteA(null);
  assert.equal(d.tipo, 'VACUUM_FULL_ANALYZE');
  assert.match(d.regra, /Sem histórico de manutenção com data válida/);
});

test('Usa a mais recente entre fonte A (local) e fonte B (estatísticas)', () => {
  // Fonte A: 10 dias; Fonte B: 45 dias → A é mais recente → NENHUMA.
  const d1 = decidirComFonteA(dataHaDias(10), 'AUTOMATICA', { fonteB: dataHaDias(45) });
  assert.equal(d1.tipo, 'NENHUMA');
  assert.equal(d1.fonteUsada, 'historico_local');

  // Fonte A: 45 dias; Fonte B: 10 dias → B é mais recente → NENHUMA.
  const d2 = decidirComFonteA(dataHaDias(45), 'AUTOMATICA', { fonteB: dataHaDias(10) });
  assert.equal(d2.tipo, 'NENHUMA');
  assert.equal(d2.fonteUsada, 'estatisticas_banco');
});

test('Escolha explícita do usuário prevalece sobre a decisão automática', () => {
  // Fonte A indicaria VACUUM FULL (75 dias), mas usuário escolheu VACUUM.
  const d = decidirComFonteA(dataHaDias(75), 'VACUUM');
  assert.equal(d.tipo, 'VACUUM');
  assert.match(d.regra, /Escolha explícita do usuário \(VACUUM\); prevalece sobre a decisão automática/);
  assert.equal(d.origem, 'explicita');
});

test('Escolha explícita NENHUMA prevalece mesmo com > 60 dias', () => {
  const d = decidirComFonteA(dataHaDias(100), 'NENHUMA');
  assert.equal(d.tipo, 'NENHUMA');
  assert.match(d.regra, /Escolha explícita do usuário/);
});

test('Modo demonstração: data simulada substitui fontes A/B', () => {
  const d = decidirComFonteA(dataHaDias(10), 'AUTOMATICA', {
    demoAtivo: true,
    dataSimulada: dataHaDias(43),
  });
  assert.equal(d.tipo, 'VACUUM');
  assert.match(d.regra, /SIMULADA/);
  assert.equal(d.origem, 'simulada');
});
