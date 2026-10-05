/**
 * telas/dashboard.js — Resumo das execuções e da última manutenção.
 */
import { api } from '../lib/api.js';
import { esc, toast } from '../lib/dom.js';
import { fmtData } from '../lib/formato.js';

export async function carregarDashboard() {
  try {
    const { execucoes } = await api('GET', '/api/execucoes');
    const sucessos = execucoes.filter(e => e.status === 'sucesso').length;
    const falhas = execucoes.filter(e => e.status === 'falha').length;
    document.getElementById('dash-sucessos').textContent = sucessos;
    document.getElementById('dash-falhas').textContent = falhas;

    const ultima = execucoes[0];
    document.getElementById('dash-ultima-execucao').textContent = ultima
      ? `#${ultima.id} — ${fmtData(ultima.inicio)} (${ultima.status})` : '—';

    // Última manutenção conhecida (fonte local).
    const comManutencao = execucoes.find(e => e.manutencao_tipo && e.manutencao_tipo !== 'NENHUMA');
    if (comManutencao) {
      document.getElementById('dash-ultima-manutencao').textContent =
        `${comManutencao.manutencao_tipo} — ${fmtData(comManutencao.inicio)}`;
      document.getElementById('dash-fonte-manutencao').textContent = comManutencao.regra_aplicada || '';
    } else {
      document.getElementById('dash-ultima-manutencao').textContent = 'Sem registro';
      document.getElementById('dash-fonte-manutencao').textContent = '';
    }

    // Resumo do banco.
    try {
      const pool = await api('GET', '/api/conexao/estado');
      if (pool.conectado) {
        document.getElementById('dash-resumo-banco').innerHTML =
          esc(`Banco: <strong>${pool.banco}</strong> — consulte o tamanho e o número de tabelas na API.`);
      }
    } catch { /* ok */ }
  } catch (e) {
    toast(e.message, 'erro');
  }
}