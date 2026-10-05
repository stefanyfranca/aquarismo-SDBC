/**
 * estado.js — Estado global compartilhado entre as telas.
 * (sessão, rota atual, execução em acompanhamento via SSE).
 */

export const estado = {
  conectado: false,
  conexao: null,
  rotaAtual: 'conexao',
  eventSource: null,
  execucaoAtiva: null,
};

export const TITULOS = {
  conexao: 'Conexão',
  dashboard: 'Dashboard',
  nova: 'Nova Execução',
  historico: 'Histórico',
  logs: 'Logs',
  configuracoes: 'Configurações',
};