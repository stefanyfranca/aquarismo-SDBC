const { Router } = require('express');
const { startExecution, getExecution } = require('../services/backup-execution.service');
const { subscribe } = require('../services/execution-events');

const router = Router();

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

module.exports = router;
