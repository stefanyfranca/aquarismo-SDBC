const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceDecision } = require('../src/services/backup-execution.service');

const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-30T12:00:00Z');

test('menos de 30 dias nao executa manutencao', () => {
  assert.equal(maintenanceDecision(new Date(now - 29 * day), now).decisao, 'NENHUMA');
});
test('limites de 30 e 60 dias usam VACUUM', () => {
  assert.equal(maintenanceDecision(new Date(now - 30 * day), now).decisao, 'VACUUM');
  assert.equal(maintenanceDecision(new Date(now - 60 * day), now).decisao, 'VACUUM');
});
test('acima de 60 dias usa VACUUM FULL ANALYZE', () => {
  assert.equal(maintenanceDecision(new Date(now - 61 * day), now).decisao, 'VACUUM_FULL_ANALYZE');
});
test('historico ausente usa VACUUM FULL ANALYZE', () => {
  assert.equal(maintenanceDecision(null, now).decisao, 'VACUUM_FULL_ANALYZE');
});
