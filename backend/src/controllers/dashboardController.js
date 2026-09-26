const dashboardService = require("../services/dashboardService");

async function getSummary(req, res) {
  try {
    const summary = await dashboardService.getSummary();
    res.json(summary);
  } catch (err) {
    console.error("Erro ao montar resumo do dashboard:", err.message);
    res.status(500).json({ message: "Não foi possível carregar o dashboard." });
  }
}

module.exports = { getSummary };
