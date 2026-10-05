/**
 * email.js — Envio de e-mail com log da execução.
 *
 * Se o SMTP estiver configurado, envia via nodemailer. Caso contrário,
 * faz SIMULAÇÃO COMPROVÁVEL: grava o e-mail completo (destinatário,
 * assunto, corpo com o log) em ./data/outbox/email-execucao-N.json e .eml.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function enviarEmailExecucao({ execucao, logs, configuracao }) {
  const destinatario = configuracao?.email_alerta || 'sbac@localhost'; // padrão para simulação

  const assunto = `[SBAC] Execução #${execucao.id} — ${execucao.status.toUpperCase()} — ${execucao.chave_conexao}`;
  const corpo = [
    `Execução #${execucao.id} da plataforma SBAC`,
    `Conexão: ${execucao.chave_conexao}`,
    `Início: ${execucao.inicio}`,
    `Fim: ${execucao.fim || '-'}`,
    `Status: ${execucao.status}`,
    `Decisão de manutenção: ${execucao.manutencao_tipo || '-'} (${execucao.regra_aplicada || '-'})`,
    `Resultado: ${execucao.resultado || '-'}`,
    '',
    '--- LOG ---',
    ...logs.map(l => `${l.data} [${l.nivel.toUpperCase()}] [${l.etapa}] ${l.mensagem}`),
  ].join('\n');

  const smtp = configuracao?.smtp_host;
  if (smtp) {
    try {
      const nodemailer = require('nodemailer');
      const transporte = nodemailer.createTransport({
        host: smtp,
        port: Number(configuracao.smtp_porta || 587),
        secure: Number(configuracao.smtp_porta) === 465,
        auth: configuracao.smtp_usuario
          ? { user: configuracao.smtp_usuario, pass: configuracao.__smtp_senha || null }
          : undefined,
      });
      await transporte.sendMail({
        from: configuracao.smtp_usuario || 'sbac@localhost',
        to: destinatario,
        subject: assunto,
        text: corpo,
      });
      return { enviado: true, simulado: false };
    } catch (e) {
      // Falha no envio real → cai na simulação comprovável.
      await simularEmail(execucao.id, destinatario, assunto, corpo, `Falha no envio SMTP: ${e.message}`);
      return { enviado: false, simulado: true, motivo: `Falha no envio SMTP: ${e.message}` };
    }
  }

  await simularEmail(execucao.id, destinatario, assunto, corpo, 'SMTP não configurado.');
  return { enviado: false, simulado: true, motivo: 'SMTP não configurado.' };
}

/** Grava o e-mail completo em ./data/outbox/ (simulação comprovável). */
async function simularEmail(execucaoId, destinatario, assunto, corpo, motivo) {
  const base = path.join(db.OUTBOX_DIR, `email-execucao-${execucaoId}`);
  const payload = {
    simulado: true,
    motivo,
    data: new Date().toISOString(),
    de: 'sbac@localhost',
    para: destinatario,
    assunto,
    corpo,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2), 'utf8');
  const eml = [
    `From: SBAC <sbac@localhost>`,
    `To: ${destinatario}`,
    `Subject: ${assunto}`,
    `Date: ${new Date().toUTCString()}`,
    `X-SBAC-Simulado: true`,
    ``,
    corpo,
  ].join('\r\n');
  fs.writeFileSync(`${base}.eml`, eml, 'utf8');
}

module.exports = { enviarEmailExecucao };
