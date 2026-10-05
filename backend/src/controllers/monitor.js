/**
 * controllers/monitor.js — Consulta de logs e controle do modo demonstração.
 */
const db = require('../lib/db');
const { chaveConexaoDe } = require('../lib/http');

/* -------------------------------- logs --------------------------------- */

function logs(req, res) {
  const { execucao_id, nivel } = req.query;
  res.json({
    logs: db.listarLogs({
      execucao_id: execucao_id ? Number(execucao_id) : undefined,
      nivel,
    }),
  });
}

/* ---------------------------- modo demonstração ------------------------- */

function lerDemo(req, res) {
  const cfg = db.getConfiguracao(chaveConexaoDe(req.sessao)) || {};
  res.json({
    ativo: !!cfg.demo_ativo,
    dataManutencao: cfg.demo_data_manutencao || null,
  });
}

function salvarDemo(req, res) {
  const { ativo, dataManutencao } = req.body || {};
  const chave = chaveConexaoDe(req.sessao);
  const cfg = db.getConfiguracao(chave) || {};
  db.salvarConfiguracao({
    chave_conexao: chave,
    demo_ativo: ativo ? 1 : 0,
    demo_data_manutencao: dataManutencao || null,
    // Preserva demais campos.
    destino: cfg.destino, quantidade_manter: cfg.quantidade_manter,
    copia_adicional: cfg.copia_adicional, compactar: cfg.compactar,
    criptografar: cfg.criptografar, pasta_bin: cfg.pasta_bin,
    email_alerta: cfg.email_alerta, smtp_host: cfg.smtp_host,
    smtp_porta: cfg.smtp_porta, smtp_usuario: cfg.smtp_usuario,
  });
  res.json({ ok: true, ativo: !!ativo, dataManutencao: dataManutencao || null });
}

module.exports = { logs, lerDemo, salvarDemo };