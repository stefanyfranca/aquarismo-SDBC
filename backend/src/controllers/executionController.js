const executionService = require("../services/executionService");
const progressBus = require("../services/progressBus");

async function getCurrent(req, res) {
  try {
    const current = await executionService.getCurrentExecution();
    res.json(current); // null quando não há execução em andamento
  } catch (err) {
    console.error("Erro ao buscar execução atual:", err.message);
    res.status(500).json({ message: "Não foi possível verificar a execução atual." });
  }
}

/**
 * Endpoint de demonstração: dispara uma execução simulada usando a
 * configuração salva, só para validar o Dashboard + SSE de ponta a
 * ponta. Quando a tela "Nova Execução" real existir, ela deve expor seu
 * próprio POST /api/executions (fluxo real) — este aqui pode conviver
 * com ele ou ser removido nessa hora.
 */
async function startDemo(req, res) {
  try {
    const result = await executionService.startDemoExecution();
    res.status(201).json(result);
  } catch (err) {
    console.error("Erro ao iniciar execução de demonstração:", err.message);
    res.status(err.status || 500).json({ message: err.message || "Não foi possível iniciar a execução." });
  }
}

function streamProgress(req, res) {
  const { id } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  const unsubscribe = progressBus.subscribe(id, ({ type, data }) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (type === "done") res.end();
  });

  req.on("close", unsubscribe);
}

module.exports = { getCurrent, startDemo, streamProgress };
