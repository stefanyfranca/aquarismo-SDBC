const configService = require("../services/configService");

async function getConfig(req, res) {
  try {
    const config = await configService.getConfig();
    res.json(config);
  } catch (err) {
    console.error("Erro ao buscar configuração:", err.message);
    res.status(500).json({ message: "Não foi possível carregar a configuração." });
  }
}

async function saveConfig(req, res) {
  try {
    const config = await configService.saveConfig(req.body);
    res.json(config);
  } catch (err) {
    console.error("Erro ao salvar configuração:", err.message);
    if (err.status) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    res.status(500).json({ message: "Não foi possível salvar a configuração." });
  }
}

module.exports = { getConfig, saveConfig };
