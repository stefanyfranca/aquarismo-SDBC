/**
 * routes/monitor.js — Logs e modo demonstração (exigem sessão).
 */
const express = require('express');

const sessao = require('../lib/sessao');
const ctrl = require('../controllers/monitor');

const router = express.Router();

router.get('/logs', sessao.exigirSessao, ctrl.logs);

router.get('/demo', sessao.exigirSessao, ctrl.lerDemo);
router.put('/demo', sessao.exigirSessao, ctrl.salvarDemo);

module.exports = router;