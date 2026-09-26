const path = require("path");
const { Pool } = require("pg");

// Carrega o .env da raiz do backend (e não do diretório de execução), para que
// `node src/server.js` funcione de qualquer lugar.
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

/**
 * Pool de conexão com o banco DA PRÓPRIA APLICAÇÃO SBAC — onde moram
 * configuracoes_backup, execucoes e logs_execucao.
 *
 * Isso é diferente da conexão com o "banco-alvo" (o banco que será
 * copiado no backup, ex.: aquarismo), que é montada dinamicamente a
 * partir do que o usuário informa na tela de Configurações
 * (ver services/targetConnectionService.js).
 */
const REQUIRED_ENV_VARS = [
  "APP_DB_HOST",
  "APP_DB_PORT",
  "APP_DB_USER",
  "APP_DB_PASSWORD",
  "APP_DB_NAME",
];

const missingVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

if (missingVars.length > 0) {
  throw new Error(
    `Configuração do banco da aplicação ausente: ${missingVars.join(", ")}. ` +
      `Copie o arquivo backend/.env.example para backend/.env e preencha os valores.`
  );
}

const appPool = new Pool({
  host: process.env.APP_DB_HOST,
  port: Number(process.env.APP_DB_PORT) || 5432,
  user: process.env.APP_DB_USER,
  password: process.env.APP_DB_PASSWORD,
  database: process.env.APP_DB_NAME,
  max: 10,
  idleTimeoutMillis: 30000,
});

appPool.on("error", (err) => {
  console.error("Erro inesperado no pool do banco da aplicação:", err.message);
});

module.exports = { appPool };
