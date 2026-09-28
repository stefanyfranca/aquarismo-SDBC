const { Pool } = require('pg');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const ssl = process.env.DB_SSL === 'true';

const config = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    };

const pool = new Pool({
  ...config,
  max: Number(process.env.DB_POOL_MAX) || 10,
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 5000
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool de conexões do banco:', err.message);
});

async function pingDb() {
  const inicio = Date.now();
  const { rows } = await pool.query(
    'SELECT current_database() AS banco, version() AS versao, now() AS horario_servidor'
  );
  return {
    banco: rows[0].banco,
    versao: rows[0].versao,
    horario_servidor: rows[0].horario_servidor,
    tempo_resposta_ms: Date.now() - inicio
  };
}

module.exports = { pool, pingDb };