/**
 * controllers/configuracao.js — Configurações por conexão (destino, retenção,
 * camadas de proteção, e-mail e modo demonstração).
 */
const db = require('../lib/db');
const v = require('../lib/validacao');
const email = require('../services/email');
const { erro, chaveConexaoDe } = require('../lib/http');

function listar(req, res) {
  const cfg = { ...(db.getConfiguracao(chaveConexaoDe(req.sessao)) || {}) };
  // Nunca devolve a senha SMTP: só o indicador de que ela existe.
  cfg.smtp_senha_definida = !!cfg.smtp_senha;
  delete cfg.smtp_senha;
  res.json(cfg);
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
    // undefined = mantém a senha atual; '' = limpa; texto = nova senha.
    smtp_senha: b.smtpSenha === undefined ? undefined : (b.smtpSenha || null),
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

/**
 * Envia um e-mail de teste com a configuração salva. Sem SMTP, o resultado
 * volta como "simulado" (grava em data/outbox/) para o front expor o motivo.
 */
async function testarEmail(req, res) {
  const chave = chaveConexaoDe(req.sessao);
  const cfg = db.getConfiguracao(chave) || {};
  if (!cfg.email_alerta) {
    return erro(res, 400, 'Informe o e-mail de alerta e salve antes de testar.');
  }
  try {
    const agora = new Date().toISOString();
    const r = await email.enviarEmailExecucao({
      execucao: {
        id: 'teste',
        status: 'teste',
        chave_conexao: chave,
        inicio: agora,
        fim: agora,
        manutencao_tipo: null,
        regra_aplicada: null,
        resultado: 'Mensagem de teste do SBAC — configuração de alertas verificada.',
      },
      logs: [],
      configuracao: cfg,
      assunto: '[SBAC] Teste de e-mail — alertas de execução',
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    return erro(res, 500, `Falha ao enviar o teste: ${e.message}`);
  }
}

module.exports = { listar, salvar, testarEmail };