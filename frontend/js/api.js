/**
 * SBAC — camada de acesso à API REST e ao stream de progresso (SSE).
 *
 * Ajuste API_BASE_URL para apontar para o backend Express.
 * Todos os endpoints abaixo são os que as telas de Configurações e
 * Dashboard esperam do backend. Alinhar nomes/rotas com quem estiver
 * implementando o backend, se forem diferentes.
 */

const API_BASE_URL = "http://localhost:3000/api";

class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (networkErr) {
    throw new ApiError("Não foi possível conectar ao servidor.", 0, networkErr);
  }

  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      (body && body.message) || `Erro na requisição (${response.status})`,
      response.status,
      body
    );
  }
  return body;
}

const Api = {
  /* ---------- Configurações de backup ---------- */
  // Esta tela cuida só das preferências de como o backup é salvo. A conexão
  // com o banco-alvo (host/porta/usuário/senha) e a manutenção manual são
  // de outras telas da equipe.
  // GET /api/config -> { caminhoDestino, quantidadeManter, caminhoCopia,
  //                       criptografar, compactar }
  getConfig() {
    return request("/config");
  },

  // PUT /api/config -> salva os parâmetros que serão usados nas próximas execuções
  saveConfig(config) {
    return request("/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
  },

  /* ---------- Dashboard ---------- */
  // GET /api/dashboard/summary -> métricas dos cards + visão geral do sistema
  getDashboardSummary() {
    return request("/dashboard/summary");
  },

  // GET /api/executions/current -> execução em andamento (ou null se não houver)
  getCurrentExecution() {
    return request("/executions/current");
  },

  // POST /api/executions -> dispara uma nova execução (usado pela tela "Nova Execução",
  // mas o Dashboard também pode iniciar uma execução rápida com a config salva)
  startExecution(payload) {
    return request("/executions", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  // POST /api/executions/demo-start -> dispara uma execução SIMULADA usando a
  // configuração salva. Existe só para testar o Dashboard (métricas + SSE) de
  // ponta a ponta antes do fluxo real de backup estar pronto.
  startDemoExecution() {
    return request("/executions/demo-start", { method: "POST" });
  },

  /**
   * Abre um stream SSE para acompanhar o progresso de uma execução em tempo real.
   * O backend deve manter a conexão aberta e emitir eventos "progress" no formato:
   *   event: progress
   *   data: {"executionId":"BK-...","step":"backup","stepLabel":"Gerando backup",
   *           "percent":42,"status":"running"}
   * e um evento "done" ao final:
   *   event: done
   *   data: {"executionId":"BK-...","status":"success"|"error","message":"..."}
   *
   * onProgress(data) é chamado a cada evento "progress".
   * onDone(data) é chamado quando a execução termina (sucesso ou falha).
   * Retorna uma função para encerrar a conexão manualmente.
   */
  subscribeToExecution(executionId, { onProgress, onDone, onError } = {}) {
    const source = new EventSource(
      `${API_BASE_URL}/executions/${executionId}/stream`
    );

    source.addEventListener("progress", (evt) => {
      try {
        onProgress?.(JSON.parse(evt.data));
      } catch (e) {
        console.error("Falha ao interpretar evento de progresso", e);
      }
    });

    source.addEventListener("done", (evt) => {
      try {
        onDone?.(JSON.parse(evt.data));
      } catch (e) {
        console.error("Falha ao interpretar evento de conclusão", e);
      }
      source.close();
    });

    source.onerror = (evt) => {
      onError?.(evt);
    };

    return () => source.close();
  },
};
