/**
 * telas/logs.js — Consulta de logs com filtros por execução e nível.
 */
import { api } from '../lib/api.js';
import { esc, toast } from '../lib/dom.js';
import { fmtData } from '../lib/formato.js';

export async function carregarLogs() {
  try {
    const { execucoes } = await api('GET', '/api/execucoes');
    const sel = document.getElementById('filtro-log-execucao');
    sel.innerHTML = '<option value="">Execução: todas</option>';
    for (const e of execucoes) {
      const op = document.createElement('option');
      op.value = e.id; op.textContent = `#${e.id} — ${e.status} — ${fmtData(e.inicio)}`;
      sel.appendChild(op);
    }
    await carregarListaLogs();
  } catch (e) {
    toast(e.message, 'erro');
  }
}

export async function carregarListaLogs() {
  const params = new URLSearchParams();
  const ex = document.getElementById('filtro-log-execucao').value;
  const nivel = document.getElementById('filtro-log-nivel').value;
  if (ex) params.set('execucao_id', ex);
  if (nivel) params.set('nivel', nivel);
  try {
    const { logs } = await api('GET', `/api/logs?${params}`);
    const div = document.getElementById('lista-logs');
    div.innerHTML = logs.map(l =>
      `<div class="linha-log ${l.nivel}"><span class="log-data">${esc(l.data)}</span> [${esc(l.etapa)}] [${esc(l.nivel)}] ${esc(l.mensagem)}</div>`
    ).join('') || '<p class="muted">Nenhum log.</p>';
  } catch (e) {
    toast(e.message, 'erro');
  }
}