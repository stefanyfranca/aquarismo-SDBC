const json = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.erro || 'Não foi possível concluir a solicitação.');
  return body;
};

export const useExecucoes = {
  iniciar: (dados) => fetch('/api/execucoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).then(json),
  obter: (id) => fetch(`/api/execucoes/${id}`).then(json),
  restaurar: (id, banco_destino) => fetch(`/api/execucoes/${id}/restaurar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ banco_destino }) }).then(json),
  listar: (filters = {}) => { const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)); return fetch(`/api/execucoes${params.size ? `?${params}` : ''}`).then(json); },
  cenarioAtivo: () => fetch('/api/execucoes/cenarios-demonstracao/ativo').then(json),
  prepararCenario: (cenario) => fetch('/api/execucoes/cenarios-demonstracao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cenario }) }).then(json),
  acompanhar(id, onProgress, onDone, onError) {
    const source = new EventSource(`/api/execucoes/${id}/eventos`);
    source.addEventListener('progresso', (event) => onProgress(JSON.parse(event.data)));
    source.addEventListener('concluida', (event) => { source.close(); onDone(JSON.parse(event.data)); });
    source.onerror = () => { source.close(); onError?.(); };
    return () => source.close();
  }
};

export const useLogs = {
  listar: async ({ execucao, etapa }) => {
    if (!execucao) return [];
    const data = await fetch(`/api/execucoes/${execucao}`).then(json);
    return (data.logs || []).filter((item) => !etapa || item.etapa === etapa).map((item) => ({ ...item, execucao_id: data.id }));
  }
};

export const useConfig = {
  obter: () => fetch('/api/configuracoes').then(json),
  salvar: (config) => fetch('/api/configuracoes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }).then(json)
};

export const getHealth = async () => {
  try { const data = await fetch('/api/health').then(json); return data.status === 'ok'; } catch { return false; }
};
