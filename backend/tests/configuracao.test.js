/**
 * configuracao.test.js — Alerta de e-mail por falha de backup:
 * a senha SMTP nunca sai pela API, a semântica manter/limpar funciona e o
 * disparo do teste de envio é comprovável (real ou simulado em data/outbox/).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const db = require('../src/lib/db');
const ctrl = require('../src/controllers/configuracao');

const SESSAO = { host: 'smtp-teste', porta: 5432, banco: 'alerta' };
const CHAVE = `${SESSAO.host}:${SESSAO.porta}/${SESSAO.banco}`;
const SEGREDO = 'token-smtp-usado-apenas-nos-testes';

function req(body = {}) {
  return { sessao: SESSAO, body };
}

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}

/** Roda o corpo dentro de uma transação desfeita no final (banco intacto). */
function transacao(fn) {
  const d = db.get();
  d.exec('BEGIN');
  try { return fn(); } finally { d.exec('ROLLBACK'); }
}

test('configuração salva com senha; listar não devolve a senha', () => {
  db.init();
  transacao(() => {
    db.salvarConfiguracao({
      chave_conexao: CHAVE,
      email_alerta: 'alerta@exemplo.test',
      smtp_host: 'smtp.exemplo.test',
      smtp_usuario: 'alerta@exemplo.test',
      smtp_senha: SEGREDO,
    });

    const r = res();
    ctrl.listar(req(), r);

    assert.equal(r.body.smtp_senha, undefined, 'a senha não pode ser devolvida');
    assert.equal(r.body.smtp_senha_definida, true, 'o front precisa saber que existe senha');
    assert.ok(!JSON.stringify(r.body).includes(SEGREDO), 'nenhum campo pode vazar o segredo');
    assert.equal(r.body.smtp_host, 'smtp.exemplo.test');
  });
});

test('senha ausente no PUT mantém a atual; string vazia limpa', () => {
  db.init();
  transacao(() => {
    db.salvarConfiguracao({ chave_conexao: CHAVE, smtp_senha: SEGREDO });

    // PUT sem smtpSenha (como o front envia quando o campo fica em branco).
    const semSenha = req({ smtpHost: 'smtp.exemplo.test' });
    ctrl.salvar(semSenha, res());
    assert.equal(db.getConfiguracao(CHAVE).smtp_senha, SEGREDO, 'senha perdida sem querer');

    // PUT explícito vazio = limpar.
    ctrl.salvar(req({ smtpSenha: '' }), res());
    assert.equal(db.getConfiguracao(CHAVE).smtp_senha, null);

    const r = res();
    ctrl.listar(req(), r);
    assert.equal(r.body.smtp_senha_definida, false);
  });
});

test('teste de e-mail sem SMTP volta como simulado e grava comprovante', async () => {
  db.init();
  const d = db.get();
  d.exec('BEGIN');
  try {
    db.salvarConfiguracao({
      chave_conexao: CHAVE,
      email_alerta: 'alerta@exemplo.test',
      smtp_host: null,
      smtp_senha: '',
    });

    const r = res();
    await ctrl.testarEmail(req(), r);

    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.enviado, false);
    assert.equal(r.body.simulado, true);
    assert.match(r.body.motivo, /SMTP não configurado/);

    const comprovante = path.join(db.OUTBOX_DIR, 'email-execucao-teste.json');
    try {
      assert.ok(fs.existsSync(comprovante), 'o simulado deve ficar comprovável em data/outbox/');
      const payload = JSON.parse(fs.readFileSync(comprovante, 'utf8'));
      assert.equal(payload.para, 'alerta@exemplo.test');
      assert.match(payload.assunto, /Teste de e-mail/);
      assert.ok(!JSON.stringify(payload).includes(SEGREDO), 'nada do segredo no e-mail');
    } finally {
      fs.rmSync(comprovante, { force: true });
      fs.rmSync(comprovante.replace(/\.json$/, '.eml'), { force: true });
    }
  } finally {
    d.exec('ROLLBACK');
  }
});

test('teste de e-mail é recusado quando não há destinatário', async () => {
  db.init();
  transacao(() => {
    db.salvarConfiguracao({ chave_conexao: CHAVE, email_alerta: null, smtp_host: null });
    const r = res();
    ctrl.testarEmail(req(), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.erro, /e-mail de alerta/);
  });
});
