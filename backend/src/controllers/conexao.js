/**
 * controllers/conexao.js — Teste de credenciais, sessão e seleção de banco.
 */
const sessao = require('../lib/sessao');
const conexao = require('../lib/conexao');
const v = require('../lib/validacao');
const { erro } = require('../lib/http');

function credenciaisDoBody(body) {
  const { host, porta, usuario, senha, banco, ssl } = body || {};
  return { host, porta, usuario, senha, banco, ssl };
}

function validarCredenciais({ host, porta, usuario, senha }) {
  const errs = [v.validarHost(host), v.validarPorta(porta), v.validarUsuario(usuario)].filter(Boolean);
  if (errs.length) return errs.join(' ');
  if (!senha) return 'Senha é obrigatória.';
  return null;
}

async function testar(req, res) {
  const c = credenciaisDoBody(req.body);
  const problema = validarCredenciais(c);
  if (problema) return erro(res, 400, problema);
  try {
    await conexao.testarConexao(c);
    res.json({ ok: true, mensagem: 'Conexão bem-sucedida.' });
  } catch (e) {
    erro(res, 400, e.message);
  }
}

async function conectar(req, res) {
  const c = credenciaisDoBody(req.body);
  const problema = validarCredenciais(c);
  if (problema) return erro(res, 400, problema);
  try {
    await conexao.testarConexao(c);
    const token = sessao.criarSessao(c);
    res.cookie(sessao.COOKIE_NAME, token, sessao.cookieOptions());
    res.json({ ok: true, mensagem: 'Conectado com sucesso.' });
  } catch (e) {
    erro(res, 400, e.message);
  }
}

function desconectar(req, res) {
  const token = sessao.extrairToken(req);
  sessao.destruirSessao(token);
  res.clearCookie(sessao.COOKIE_NAME, { path: '/' });
  res.json({ ok: true, mensagem: 'Desconectado.' });
}

async function estado(req, res) {
  const base = {
    host: req.sessao.host,
    porta: req.sessao.porta,
    usuario: req.sessao.usuario,
    banco: req.sessao.banco,
  };
  try {
    res.json({ conectado: await conexao.healthcheck(req.sessao), ...base });
  } catch {
    res.json({ conectado: false, ...base });
  }
}

async function listarBancos(req, res) {
  try {
    res.json({ bancos: await conexao.listarBancos(req.sessao) });
  } catch (e) {
    erro(res, 400, e.message);
  }
}

async function selecionarBanco(req, res) {
  const { banco } = req.body || {};
  const erroBanco = v.validarBanco(banco);
  if (erroBanco) return erro(res, 400, erroBanco);
  try {
    const pool = conexao.conectar(req.sessao, banco);
    await pool.query('SELECT 1');
    res.json({ ok: true, banco });
  } catch (e) {
    erro(res, 400, `Não foi possível selecionar o banco "${banco}": ${e.message}`);
  }
}

module.exports = { testar, conectar, desconectar, estado, listarBancos, selecionarBanco };