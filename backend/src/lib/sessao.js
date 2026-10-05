/**
 * sessao.js — Sessões em memória com token aleatório em cookie HttpOnly.
 *
 * A senha do banco fica SOMENTE aqui (memória do servidor) e nunca é
 * devolvida ao frontend. Expiração por inatividade de 30 minutos.
 */
const crypto = require('crypto');

const EXPIRACAO_MS = 30 * 60 * 1000; // 30 minutos
const COOKIE_NAME = 'sbac_sessao';

/** @type {Map<string, {token, host, porta, usuario, banco, ssl, pool, ultimoAcesso}>} */
const sessoes = new Map();

function criarSessao(dados) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, {
    token,
    host: dados.host,
    porta: Number(dados.porta),
    usuario: dados.usuario,
    senha: dados.senha,       // somente em memória
    banco: dados.banco || null,
    ssl: !!dados.ssl,
    pool: null,               // criado sob demanda por conexao.js
    ultimoAcesso: Date.now(),
  });
  return token;
}

function obterSessao(token) {
  if (!token) return null;
  const s = sessoes.get(token);
  if (!s) return null;
  if (Date.now() - s.ultimoAcesso > EXPIRACAO_MS) {
    destruirSessao(token);
    return null;
  }
  s.ultimoAcesso = Date.now();
  return s;
}

function destruirSessao(token) {
  const s = sessoes.get(token);
  if (!s) return;
  if (s.pool) {
    s.pool.end().catch(() => {});
    s.pool = null;
  }
  sessoes.delete(token);
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'Strict',
    secure: false, // aplicação serve em 127.0.0.1
    maxAge: EXPIRACAO_MS,
    path: '/',
  };
}

function extrairToken(req) {
  const header = req.headers.cookie || '';
  for (const parte of header.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Middleware: exige sessão válida; anexa req.sessao. */
function exigirSessao(req, res, next) {
  const token = extrairToken(req);
  const s = obterSessao(token);
  if (!s) {
    return res.status(401).json({ erro: 'Sessão expirada ou inexistente. Conecte-se novamente.' });
  }
  req.sessao = s;
  req.tokenSessao = token;
  next();
}

module.exports = {
  criarSessao, obterSessao, destruirSessao,
  cookieOptions, extrairToken, exigirSessao, COOKIE_NAME,
};
