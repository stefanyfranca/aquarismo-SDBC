/**
 * telas/historico.js — Histórico de execuções e detalhes (com log completo).
 */
import { api } from '../lib/api.js';
import { esc, toast } from '../lib/dom.js';
import { fmtData, fmtDuracao } from '../lib/formato.js';
import { abrirRestauracao } from './restauracao.js';

export async function carregarHistorico() {
  try {
    const params = new URLSearchParams();
    const status = document.getElementById('filtro-status').value;
    const periodo = document.getElementById('filtro-periodo').value;
    if (status) params.set('status', status);
    if (periodo) params.set('dias', periodo);
    const { execucoes } = await api('GET', `/api/execucoes?${params}`);
    const tbody = document.querySelector('#tabela-historico tbody');
    tbody.innerHTML = '';
    for (const e of execucoes) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${e.id}</td>
        <td>${fmtData(e.inicio)}</td>
        <td>${fmtData(e.fim)}</td>
        <td>${fmtDuracao(e.inicio, e.fim)}</td>
        <td><span class="etiqueta ${e.status}">${e.status}</span></td>
        <td>${esc(e.manutencao_tipo || '—')}</td>
        <td>${esc(e.regra_aplicada || '—')}</td>
        <td>${esc(e.resultado || '—')}</td>
        <td><button class="btn btn-secundario btn-pequeno" data-id="${e.id}">Detalhes</button></td>
      `;
      tr.querySelector('button').addEventListener('click', () => abrirDetalhes(e.id));
      tbody.appendChild(tr);
    }
    if (execucoes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">Nenhuma execução encontrada.</td></tr>';
    }
  } catch (e) {
    toast(e.message, 'erro');
  }
}

export async function abrirDetalhes(id) {
  try {
    const { execucao, logs } = await api('GET', `/api/execucoes/${id}`);
    document.getElementById('modal-detalhes-titulo').textContent = `Execução #${id} — ${execucao.status}`;
    let html = `
      <p><strong>Início:</strong> ${fmtData(execucao.inicio)} | <strong>Fim:</strong> ${fmtData(execucao.fim)} | <strong>Duração:</strong> ${fmtDuracao(execucao.inicio, execucao.fim)}</p>
      <p><strong>Decisão:</strong> ${esc(execucao.manutencao_tipo || '—')}</p>
      <p><strong>Regra:</strong> ${esc(execucao.regra_aplicada || '—')}</p>
      <p><strong>Resultado:</strong> ${esc(execucao.resultado || '—')}</p>
      <p><strong>Arquivo final:</strong> ${esc(execucao.arquivo_final || '—')}</p>
      <h4 style="margin:14px 0 6px">Log completo</h4>
      <div class="lista-logs" style="max-height:300px">
        ${logs.map(l => `<div class="linha-log ${l.nivel}"><span class="log-data">${esc(l.data)}</span> [${esc(l.etapa)}] ${esc(l.mensagem)}</div>`).join('')}
      </div>
    `;
    if (execucao.status === 'sucesso' && execucao.arquivo_final) {
      html += `<div class="linha-botoes"><button class="btn btn-primario" id="btn-restaurar">Restaurar e conferir integridade</button></div>`;
    }
    document.getElementById('modal-detalhes-corpo').innerHTML = html;
    document.getElementById('modal-detalhes').style.display = 'flex';
    document.getElementById('modal-detalhes-fechar').onclick = () => {
      document.getElementById('modal-detalhes').style.display = 'none';
    };
    const btnR = document.getElementById('btn-restaurar');
    if (btnR) btnR.addEventListener('click', () => abrirRestauracao(execucao));
  } catch (e) {
    toast(e.message, 'erro');
  }
}