const { Router } = require('express');
const { startExecution, getExecution, listExecutions, prepareMaintenanceScenario, getPreparedMaintenanceScenario } = require('../services/backup-execution.service');
const { subscribe } = require('../services/execution-events');
const { spawn } = require('child_process');
const path = require('path');
const { pool } = require('../database/pool');
const { registrarEvento } = require('../services/backup-execution.service');

const router = Router();

router.get('/cenarios-demonstracao/ativo', async (_req, res, next) => {
  try { res.json(await getPreparedMaintenanceScenario()); } catch (error) { next(error); }
});

router.post('/cenarios-demonstracao', async (req, res, next) => {
  try { res.status(201).json(await prepareMaintenanceScenario(req.body?.cenario)); } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await listExecutions({ status: req.query.status, banco: req.query.banco, dias: req.query.dias, limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const execution = await startExecution(req.body || {});
    res.status(202).json({
      id: execution.id,
      status: execution.status,
      data_inicio: execution.data_inicio,
      status_url: `/api/execucoes/${execution.id}`,
      eventos_url: `/api/execucoes/${execution.id}/eventos`
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ erro: 'id inválido.' });
    const execution = await getExecution(id);
    return execution ? res.json(execution) : res.status(404).json({ erro: 'Execução não encontrada.' });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/eventos', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();
    if (!await getExecution(id, false)) return res.status(404).json({ erro: 'Execução não encontrada.' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: conectado\ndata: ${JSON.stringify({ id })}\n\n`);
    const unsubscribe = subscribe(id, ({ event, data }) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    req.on('close', unsubscribe);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/restaurar', async (req, res, next) => {
  const id = Number(req.params.id);
  const target = String(req.body?.banco_destino || '');
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(target)) {
    return res.status(400).json({ erro: 'Informe um banco de destino novo com nome PostgreSQL válido.' });
  }
  try {
    const { rows } = await pool.query(`SELECT e.status, e.caminho_arquivo_backup FROM execucoes e WHERE e.id = $1`, [id]);
    if (!rows[0] || rows[0].status !== 'sucesso' || !rows[0].caminho_arquivo_backup) return res.status(400).json({ erro: 'A execução não possui backup concluído para restaurar.' });
    const archive = rows[0].caminho_arquivo_backup;
    await registrarEvento(id, 'restauracao', `Iniciada restauração para o banco novo ${target}.`);
    const script = path.resolve(__dirname, '../scripts/restore-backup.js');
    const child = spawn(process.execPath, [script, archive, target], { cwd: path.resolve(__dirname, '../..'), windowsHide: true, shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
    child.once('error', async (error) => { await registrarEvento(id, 'restauracao', 'Falha ao iniciar a ferramenta de restauração.', error.message).catch(() => {}); if (!res.headersSent) res.status(500).json({ erro: 'Não foi possível iniciar a restauração.' }); });
    child.once('close', async (code) => {
      if (res.headersSent) return;
      if (code !== 0) { await registrarEvento(id, 'restauracao', 'Restauração ou validação de integridade falhou.', stderr.slice(-3000)).catch(() => {}); return res.status(500).json({ erro: stderr.trim().split('\n').at(-1) || 'Falha na restauração.' }); }
      try { const resultado = JSON.parse(stdout); await registrarEvento(id, 'restauracao', `Banco ${target} restaurado; contagens e resumos de conteúdo MD5 validados.`); return res.json(resultado); }
      catch (error) { return res.status(500).json({ erro: 'A ferramenta terminou sem resultado de validação legível.' }); }
    });
  } catch (error) { next(error); }
});

module.exports = router;
