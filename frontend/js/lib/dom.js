/**
 * lib/dom.js — Escapamento de HTML e avisos temporários (toast).
 */

/** Escapa texto para inserção segura em innerHTML (prevenção de XSS). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** @param {'info'|'ok'|'erro'} tipo */
export function toast(msg, tipo = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}