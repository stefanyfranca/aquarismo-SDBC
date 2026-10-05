/**
 * app.js — Bootstrap e roteamento por hash do frontend SBAC
 * (HTML/CSS/JS puros, sem framework).
 *
 * Rotas: #/conexao, #/dashboard, #/nova, #/historico, #/logs, #/configuracoes.
 * Cada tela vive em js/telas/; o estado compartilhado em js/estado.js.
 */
import { TITULOS, estado } from './estado.js';
import { initConexao, atualizarIndicador } from './telas/conexao.js';
import { carregarDashboard } from './telas/dashboard.js';
import { initNovaExecucao, carregarNovaExecucao } from './telas/execucao.js';
import { carregarHistorico } from './telas/historico.js';
import { carregarLogs, carregarListaLogs } from './telas/logs.js';
import { initConfiguracoes, carregarConfiguracoes } from './telas/configuracoes.js';

/* -------------------------------- Router ------------------------------- */

const TELAS = {
  dashboard: carregarDashboard,
  nova: carregarNovaExecucao,
  historico: carregarHistorico,
  logs: carregarLogs,
  configuracoes: carregarConfiguracoes,
};

function navegar(rota) {
  if (!TITULOS[rota]) rota = 'conexao';
  estado.rotaAtual = rota;
  if (estado.eventSource) { estado.eventSource.close(); estado.eventSource = null; }

  document.querySelectorAll('.tela').forEach(t => t.style.display = 'none');
  document.getElementById(`tela-${rota}`).style.display = 'block';
  document.querySelectorAll('.menu a').forEach(a => {
    a.classList.toggle('ativo', a.dataset.rota === rota);
  });
  document.getElementById('breadcrumb').textContent = `SBAC / ${TITULOS[rota]}`;
  document.getElementById('titulo-pagina').textContent = TITULOS[rota];

  // Bloqueia telas que exigem conexão.
  if (rota !== 'conexao' && !estado.conectado) {
    location.hash = '#/conexao';
    return;
  }

  TELAS[rota]?.();
}

window.addEventListener('hashchange', () => navegar(location.hash.slice(2) || 'conexao'));

/* -------------------------------- Init --------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  initConexao();
  initNovaExecucao();
  initConfiguracoes();
  document.getElementById('btn-filtrar').addEventListener('click', carregarHistorico);
  document.getElementById('filtro-log-execucao').addEventListener('change', carregarListaLogs);
  document.getElementById('filtro-log-nivel').addEventListener('change', carregarListaLogs);
  atualizarIndicador();
  navegar(location.hash.slice(2) || 'conexao');
});