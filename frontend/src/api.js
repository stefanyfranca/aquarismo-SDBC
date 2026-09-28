import { mockConfig, mockExecucoes, mockLogs } from './mocks.js';

const json = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.erro || 'Não foi possível concluir a solicitação.');
  return body;
};

export const useExecucoes = {
  iniciar: (dados) => fetch('/api/execucoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).then(json),
  obter: (id) => fetch(`/api/execucoes/${id}`).then(json),
  listar: async () => mockExecucoes,
  acompanhar(id, onProgress, onDone, onError) {
    const source = new EventSource(`/api/execucoes/${id}/eventos`);
    source.addEventListener('progresso', (event) => onProgress(JSON.parse(event.data)));
    source.addEventListener('concluida', (event) => { source.close(); onDone(JSON.parse(event.data)); });
    source.onerror = () => { source.close(); onError?.(); };
    return () => source.close();
  }
};

export const useLogs = {
  listar: async ({ execucao, etapa }) => mockLogs.filter((item) => (!execucao || String(item.execucao_id) === execucao) && (!etapa || item.etapa === etapa))
};

let savedConfig = { ...mockConfig };
export const useConfig = {
  obter: async () => ({ ...savedConfig }),
  salvar: async (config) => { savedConfig = { ...config }; return { ...savedConfig }; }
};

export const getHealth = async () => {
  try { const data = await fetch('/api/health').then(json); return data.status === 'ok'; } catch { return false; }
};
