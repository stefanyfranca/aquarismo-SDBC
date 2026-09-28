const { Router } = require('express');
const { pingDb } = require('../database/pool');

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const info = await pingDb();
    res.json({
      status: 'ok',
      servidor: 'operacional',
      banco: {
        conectado: true,
        banco: info.banco,
        versao: info.versao,
        horario_servidor: info.horario_servidor,
        tempo_resposta_ms: info.tempo_resposta_ms
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Falha no teste de conexão com o banco:', err.message);
    res.status(503).json({
      status: 'error',
      servidor: 'operacional',
      banco: {
        conectado: false,
        erro: 'Falha ao conectar ao banco de dados'
      },
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;