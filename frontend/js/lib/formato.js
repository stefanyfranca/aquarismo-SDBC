/**
 * lib/formato.js — Formatação de datas e durações (pt-BR).
 */

export function fmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleString('pt-BR');
}

export function fmtDuracao(inicio, fim) {
  if (!inicio || !fim) return '—';
  const ms = new Date(fim.replace(' ', 'T')) - new Date(inicio.replace(' ', 'T'));
  if (isNaN(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}min ${s % 60}s`;
}