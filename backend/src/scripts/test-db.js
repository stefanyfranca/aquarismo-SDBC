const { pool } = require('../database/pool');

async function main() {
  console.log('Testando conexão com o PostgreSQL...');
  try {
    const { rows } = await pool.query(
      'SELECT current_database() AS banco, current_user AS usuario, version() AS versao'
    );
    console.log('Conexão OK');
    console.log(`  Banco ...: ${rows[0].banco}`);
    console.log(`  Usuário .: ${rows[0].usuario}`);
    console.log(`  Versão ..: ${rows[0].versao}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Falha ao conectar ao banco.');
    console.error('  Detalhe:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();