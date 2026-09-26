const path = require("path");
const express = require("express");
const cors = require("cors");

const configRoutes = require("./routes/configRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const executionRoutes = require("./routes/executionRoutes");

const app = express();

app.use(cors()); // libera o frontend estático (aberto via arquivo ou live server)
app.use(express.json());

app.use("/api/config", configRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/executions", executionRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Frontend servido pelo próprio backend: com o servidor no ar, basta abrir
// http://localhost:3000 em vez de dar duplo clique nos .html. Abrir os arquivos
// direto do disco continua funcionando (o CORS acima cobre esse caso).
const frontendDir = path.resolve(__dirname, "..", "..", "frontend");
app.use(express.static(frontendDir));
app.get("/", (req, res) => res.sendFile(path.join(frontendDir, "dashboard.html")));

// Tratador de erro genérico (evita vazar detalhes sensíveis nas respostas)
app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err.message);
  res.status(500).json({ message: "Erro interno no servidor." });
});

module.exports = app;
