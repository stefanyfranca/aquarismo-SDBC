const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { pool } = require('../database/pool');
const { caminhoFerramenta, argumentosConexao, ambienteFilho } = require('../services/postgres-tools');

const TABLES = [
  'clientes', 'especies', 'lotes', 'produtos_acessorios', 'pedidos',
  'itens_pedido', 'movimentacoes_estoque', 'configuracoes_backup', 'execucoes', 'logs_execucao'
];
const BUSINESS_TABLES = [
  'clientes', 'especies', 'lotes', 'produtos_acessorios', 'pedidos',
  'itens_pedido', 'movimentacoes_estoque'
];

function connectionConfig(database) {
  const config = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' }
    : { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database,
        ssl: process.env.DB_SSL === 'true' };
  if (database) config.database = database;
  return config;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} terminou com codigo ${code}: ${output.slice(-3000)}`)));
  });
}

function ensureAllowedFile(file) {
  const roots = (process.env.BACKUP_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean).map((root) => path.resolve(root));
  const resolved = path.resolve(file);
  if (!roots.length || !roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) throw new Error('O arquivo deve estar dentro de BACKUP_ALLOWED_ROOTS.');
  return resolved;
}

async function counts(client) {
  const result = {};
  for (const table of TABLES) {
    const { rows } = await client.query(`SELECT count(*)::bigint AS total FROM public."${table}"`);
    result[table] = Number(rows[0].total);
  }
  return result;
}

async function main() {
  const [, , suppliedFile, target] = process.argv;
  if (!suppliedFile || !target || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(target)) {
    throw new Error('Uso: npm run restore -- <arquivo.dump> <novo_banco_de_validacao>');
  }
  if (target === process.env.DB_NAME) throw new Error('O banco configurado para a aplicacao nao pode ser substituido por este comando.');
  const file = ensureAllowedFile(suppliedFile);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('O caminho informado nao e um arquivo.');
  if (!file.toLowerCase().endsWith('.dump')) throw new Error('Este comando restaura arquivos .dump em formato custom do pg_dump.');

  const source = new Client(connectionConfig(process.env.DB_NAME));
  let sourceCounts;
  try {
    await source.connect();
    sourceCounts = await counts(source);
    const exists = await source.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (exists.rowCount) throw new Error(`O banco ${target} ja existe; escolha um nome novo para evitar sobrescrever dados.`);
    await source.query(`CREATE DATABASE "${target}" TEMPLATE template0 ENCODING 'UTF8'`);
  } finally { await source.end().catch(() => {}); }

  const executable = caminhoFerramenta('pg_restore');
  const args = ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', target, file];
  args.push(...argumentosConexao());
  await run(executable, args, { env: ambienteFilho() });

  const restored = new Client(connectionConfig(target));
  let restoredCounts;
  try { await restored.connect(); restoredCounts = await counts(restored); }
  finally { await restored.end().catch(() => {}); }
  const differences = BUSINESS_TABLES.filter((table) => sourceCounts[table] !== restoredCounts[table]);
  const controlTablesAhead = TABLES.filter((table) => !BUSINESS_TABLES.includes(table) && restoredCounts[table] > sourceCounts[table]);
  if (differences.length || controlTablesAhead.length) {
    throw new Error(`Restauracao concluida, mas ha divergencia: dados de negocio [${differences.join(', ')}], controles [${controlTablesAhead.join(', ')}]. Banco mantido para analise.`);
  }
  console.log(JSON.stringify({
    status: 'validado', arquivo: file, banco_restaurado: target,
    contagens_negocio_iguais: BUSINESS_TABLES.reduce((result, table) => { result[table] = restoredCounts[table]; return result; }, {}),
    contagens_controle_origem: { configuracoes_backup: sourceCounts.configuracoes_backup, execucoes: sourceCounts.execucoes, logs_execucao: sourceCounts.logs_execucao },
    contagens_controle_restaurado: { configuracoes_backup: restoredCounts.configuracoes_backup, execucoes: restoredCounts.execucoes, logs_execucao: restoredCounts.logs_execucao },
    nota: 'Metadados e logs de controle podem mudar depois do instante em que o dump foi capturado.'
  }, null, 2));
}

main().catch((error) => {
  console.error(`Falha na restauracao: ${error.message}`);
  console.error('Se o banco de validacao ja tiver sido criado, ele foi mantido para inspecao e pode ser removido manualmente depois.');
  process.exitCode = 1;
}).finally(() => pool.end());
