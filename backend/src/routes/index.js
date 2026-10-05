/**
 * routes/index.js — Agregador das rotas da API REST e SSE.
 *
 * Contrato (conforme enunciado):
 *   POST /api/conexao/testar      — testa credenciais
 *   POST /api/conexao             — conecta (cria sessão)
 *   DELETE /api/conexao           — desconecta (destrói sessão e pools)
 *   GET  /api/conexao/estado      — estado real (healthcheck SELECT 1)
 *   GET  /api/bancos              — lista bancos disponíveis
 *   POST /api/bancos/selecionar — troca o banco da sessão
 *   GET|PUT /api/configuracao     — configurações por conexão
 *   POST /api/validar             — testa conexão, permissões e diretórios
 *   POST /api/decisao             — prévia da decisão de manutenção
 *   POST /api/execucoes           — inicia execução (202 + id; 409 se bloqueante)
 *   GET  /api/execucoes           — histórico com filtros
 *   GET  /api/execucoes/:id       — detalhe
 *   GET  /api/execucoes/:id/eventos — SSE (reenvia estado ao conectar)
 *   POST /api/execucoes/:id/restaurar — restaura e confere integridade
 *   GET  /api/logs                — logs com filtros
 *   GET  /api/demo                — estado do modo demonstração
 *   PUT  /api/demo                — ativa/desativa e define data simulada
 *
 * Todas (exceto /api/conexao*) exigem sessão válida.
 * Erros sempre JSON {erro: "mensagem clara"}.
 *
 * Cada domínio vive em seu próprio router:
 *   routes/conexao.js       → controllers/conexao.js
 *   routes/configuracao.js  → controllers/configuracao.js
 *   routes/execucoes.js     → controllers/execucoes.js
 *   routes/monitor.js       → controllers/monitor.js
 */
const express = require('express');

const router = express.Router();

router.use(require('./conexao'));
router.use(require('./configuracao'));
router.use(require('./execucoes'));
router.use(require('./monitor'));

module.exports = router;