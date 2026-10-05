/**
 * routes/execucoes.js — Pré-checagens, decisão, execuções, SSE e restauração.
 */
const express = require('express');

const sessao = require('../lib/sessao');
const ctrl = require('../controllers/execucoes');

const router = express.Router();

router.post('/validar', sessao.exigirSessao, ctrl.validar);
router.post('/decisao', sessao.exigirSessao, ctrl.decisao);

router.post('/execucoes', sessao.exigirSessao, ctrl.iniciar);
router.get('/execucoes', sessao.exigirSessao, ctrl.listar);
router.get('/execucoes/:id', sessao.exigirSessao, ctrl.detalhar);
router.get('/execucoes/:id/eventos', sessao.exigirSessao, ctrl.eventos);
router.post('/execucoes/:id/restaurar', sessao.exigirSessao, ctrl.restaurar);
router.get('/execucoes/:id/restaurar/eventos', sessao.exigirSessao, ctrl.eventosRestauracao);

module.exports = router;