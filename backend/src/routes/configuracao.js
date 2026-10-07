/**
 * routes/configuracao.js — Configurações por conexão (exigem sessão).
 */
const express = require('express');

const sessao = require('../lib/sessao');
const ctrl = require('../controllers/configuracao');

const router = express.Router();

router.get('/configuracao', sessao.exigirSessao, ctrl.listar);
router.put('/configuracao', sessao.exigirSessao, ctrl.salvar);
router.post('/configuracao/testar-email', sessao.exigirSessao, ctrl.testarEmail);

module.exports = router;