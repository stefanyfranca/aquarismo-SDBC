/**
 * http.js — Utilitários compartilhados pelos controllers da API.
 */

/** Resposta de erro padronizada: sempre JSON {erro: "mensagem clara"}. */
function erro(res, status, msg) {
  return res.status(status).json({ erro: msg });
}

/** Identificador estável da sessão: host:porta/banco. */
function chaveConexaoDe(sessao) {
  return `${sessao.host}:${sessao.porta}/${sessao.banco}`;
}

module.exports = { erro, chaveConexaoDe };