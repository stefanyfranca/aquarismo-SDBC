/**
 * lib/api.js — Cliente HTTP da API (sessão por cookie, erros em JSON).
 */

/**
 * @param {'GET'|'POST'|'PUT'|'DELETE'} metodo
 * @param {string} url
 * @param {object} [corpo] — se enviado, vai como JSON
 * @throws {Error} com .status e .dados em respostas de erro.
 */
export async function api(metodo, url, corpo) {
  const opts = { method: metodo, headers: {}, credentials: 'same-origin' };
  if (corpo !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(corpo);
  }
  const r = await fetch(url, opts);
  let dados = null;
  try { dados = await r.json(); } catch { /* sem corpo */ }
  if (!r.ok) {
    const e = new Error(dados?.erro || `Erro HTTP ${r.status}`);
    e.status = r.status;
    e.dados = dados;
    throw e;
  }
  return dados;
}