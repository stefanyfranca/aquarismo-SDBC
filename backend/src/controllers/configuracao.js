/**
 * controllers/configuracao.js — Configurações por conexão (destino, retenção,
 * camadas de proteção, e-mail e modo demonstração).
 */
const db = require('../lib/db');
const v = require('../lib/validacao');
const { erro, chaveConexaoDe } = require('../lib/http');

function listar(req, res) {
  res.json(db.getConfiguracao(chaveConexaoDe(req.sessao)) || {});
}

function salvar(req, res) {
  const b = req.body || {};
  const chave = chaveConexaoDe(req.sessao);
  const atual = db.getConfiguracao(chave) || {};
  const nova = {
    chave_conexao: chave,
    destino: b.destino ?? atual.destino ?? null,
    quantidade_manter: b.quantidadeManter ?? atual.quantidade_manter ?? null,
    copia_adicional: b.copiaAdicional ?? atual.copia_adicional ?? null,
    compactar: b.compactar ?? atual.compactar ?? 0,
    criptografar: b.criptografar ?? atual.criptografar ?? 0,
    pasta_bin: b.pastaBin ?? atual.pasta_bin ?? null,
    email_alerta: b.emailAlerta ?? atual.email_alerta ?? null,
    smtp_host: b.smtpHost ?? atual.smtp_host ?? null,
    smtp_porta: b.smtpPorta ?? atual.smtp_porta ?? null,
    smtp_usuario: b.smtpUsuario ?? atual.smtp_usuario ?? null,
    demo_ativo: b.demoAtivo ?? atual.demo_ativo ?? 0,
    demo_data_manutencao: b.demoDataManutencao ?? atual.demo_data_manutencao ?? null,
  };
  // Valida caminhos se presentes.
  if (nova.destino) {
    const e = v.validarCaminho(nova.destino, { rotulo: 'Destino' });
    if (e) return erro(res, 400, e);
  }
  if (nova.copia_adicional) {
    const e = v.validarCaminho(nova.copia_adicional, { rotulo: 'Cópia adicional' });
    if (e) return erro(res, 400, e);
  }
  db.salvarConfiguracao(nova);
  res.json({ ok: true, mensagem: 'Configuração salva.' });
}

module.exports = { listar, salvar };