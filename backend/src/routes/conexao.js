/**
 * routes/conexao.js — Sessão e seleção de banco.
 * exceto /api/conexao*, exigem sessão válida.
 */
const express = require('express');

const sessao = require('../lib/sessao');
const ctrl = require('../controllers/conexao');

const router = express.Router();

router.post('/conexao/testar', ctrl.testar);
router.post('/conexao', ctrl.conectar);
router.delete('/conexao', ctrl.desconectar);
router.get('/conexao/estado', sessao.exigirSessao, ctrl.estado);
router.get('/bancos', sessao.exigirSessao, ctrl.listarBancos);
router.post('/bancos/selecionar', sessao.exigirSessao, ctrl.selecionarBanco);

module.exports = router;