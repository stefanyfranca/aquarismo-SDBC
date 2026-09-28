const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { pool } = require('../database/pool');
const { publish } = require('./execution-events');

const MANUTENCOES = {
  none: 'NENHUMA',
  vacuum: 'VACUUM',
  vacuum_full_analyze: 'VACUUM_FULL_ANALYZE'
};

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function redact(value) {
  return String(value || '')
    .replace(/(password|senha|key|chave)=?[^\s&]*/gi, '$1=[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@')
    .slice(0, 4000);
}

function allowedRoots() {
  const raw = process.env.BACKUP_ALLOWED_ROOTS || '';
  const roots = raw.split(path.delimiter).filter(Boolean).map((root) => path.resolve(root));
  if (!roots.length) throw new Error('BACKUP_ALLOWED_ROOTS não foi configurada.');
  return roots;
}

function safeDirectory(input, field) {
  if (typeof input !== 'string' || !input.trim()) throw validationError(`${field} é obrigatório.`);
  if (input.includes('\0')) throw validationError(`${field} contém caractere inválido.`);
  const resolved = path.resolve(input);
  const root = allowedRoots().find((candidate) => {
    const relative = path.relative(candidate, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!root) throw validationError(`${field} deve estar dentro de BACKUP_ALLOWED_ROOTS.`);
  return resolved;
}

function normalizeInput(body) {
  const banco = typeof body.banco === 'string' ? body.banco.trim() : '';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(banco)) {
    throw validationError('banco é obrigatório e deve ser um identificador PostgreSQL válido.');
  }
  if (process.env.DB_NAME && banco !== process.env.DB_NAME) {
    throw validationError('Por segurança, banco deve ser igual ao banco configurado para a aplicação.');
  }
  const qtdManter = body.qtd_manter === undefined ? 7 : Number(body.qtd_manter);
  if (!Number.isInteger(qtdManter) || qtdManter <= 0) {
    throw validationError('qtd_manter deve ser um inteiro maior que zero.');
  }
  for (const field of ['compactacao', 'criptografia']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      throw validationError(`${field} deve ser booleano.`);
    }
  }
  const explicit = body.manutencao_explicita;
  if (explicit !== undefined && !Object.hasOwn(MANUTENCOES, explicit)) {
    throw validationError('manutencao_explicita deve ser none, vacuum ou vacuum_full_analyze.');
  }
  return {
    banco,
    destino: safeDirectory(body.destino, 'destino'),
    qtdManter,
    caminhoCopia: body.caminho_copia_adicional === undefined || body.caminho_copia_adicional === ''
      ? null : safeDirectory(body.caminho_copia_adicional, 'caminho_copia_adicional'),
    compactacao: body.compactacao === true,
    criptografia: body.criptografia === true,
    manutencaoExplicita: explicit
  };
}

async function log(executionId, etapa, mensagem, technical = null) {
  await pool.query(
    `INSERT INTO logs_execucao (execucao_id, etapa, mensagem, saida_tecnica)
     VALUES ($1, $2, $3, $4)`,
    [executionId, etapa, mensagem, technical ? redact(technical) : null]
  );
  publish(executionId, 'progresso', { etapa, mensagem, data: new Date().toISOString() });
}

async function decideMaintenance(explicit) {
  if (explicit) return { decisao: MANUTENCOES[explicit], regra: 'Escolha manual do usuário.' };
  const { rows } = await pool.query(
    `SELECT data_fim FROM execucoes
     WHERE status = 'sucesso'
       AND decisao_manutencao IN ('VACUUM', 'VACUUM_ANALYZE', 'VACUUM_FULL_ANALYZE')
       AND data_fim IS NOT NULL
     ORDER BY data_fim DESC LIMIT 1`
  );
  if (!rows[0]?.data_fim) return { decisao: 'VACUUM_FULL_ANALYZE', regra: 'Sem histórico de manutenção com data válida.' };
  const days = (Date.now() - new Date(rows[0].data_fim).getTime()) / 86400000;
  if (days < 30) return { decisao: 'NENHUMA', regra: `Última manutenção há ${days.toFixed(1)} dias (< 30).` };
  if (days <= 60) return { decisao: 'VACUUM', regra: `Última manutenção há ${days.toFixed(1)} dias (entre 30 e 60).` };
  return { decisao: 'VACUUM_FULL_ANALYZE', regra: `Última manutenção há ${days.toFixed(1)} dias (> 60).` };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, ...options });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} terminou com código ${code}: ${redact(output)}`)));
  });
}

async function encryptFile(input) {
  const encodedKey = process.env.BACKUP_ENCRYPTION_KEY || '';
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY deve conter uma chave AES-256 válida em base64.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const output = `${input}.aes`;
  await pipeline(require('fs').createReadStream(input), cipher, require('fs').createWriteStream(output));
  await fs.appendFile(output, Buffer.concat([Buffer.from('AQBK1', 'ascii'), iv, cipher.getAuthTag()]));
  // O cabeçalho ao fim preserva IV e tag; o restaurador deve ler os últimos 33 bytes.
  return output;
}

async function compactFile(input) {
  const password = process.env.ZIP_PASSWORD;
  if (!password) throw new Error('ZIP_PASSWORD é obrigatória quando compactacao estiver habilitada.');
  const output = input.replace(/\.[^.]+$/, '') + '.zip';
  await run(process.env.SEVEN_ZIP_PATH || '7z', ['a', '-tzip', '-mem=AES256', `-p${password}`, output, input]);
  return output;
}

function pgDumpOptions(banco, output) {
  const args = ['--format=custom', '--file', output, '--dbname', banco];
  if (process.env.DB_HOST) args.push('--host', process.env.DB_HOST);
  if (process.env.DB_PORT) args.push('--port', process.env.DB_PORT);
  if (process.env.DB_USER) args.push('--username', process.env.DB_USER);
  // PGPASSWORD é passado somente ao processo filho, sem ser incluído nos argumentos ou logs.
  const env = { ...process.env };
  if (process.env.DB_PASSWORD) env.PGPASSWORD = process.env.DB_PASSWORD;
  return { args, env };
}

async function retainBackups(directory, banco, quantity, current) {
  const prefix = `backup-${banco}-`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const backups = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    return { fullPath, mtime: (await fs.stat(fullPath)).mtimeMs };
  }));
  backups.sort((a, b) => b.mtime - a.mtime);
  for (const backup of backups.slice(quantity)) {
    if (backup.fullPath !== current) await fs.unlink(backup.fullPath);
  }
}

async function execute(executionId, input) {
  let currentFile;
  try {
    await log(executionId, 'validacao', 'Validando conexão e diretórios autorizados.');
    await pool.query('SELECT 1');
    await fs.mkdir(input.destino, { recursive: true });
    if (input.caminhoCopia) await fs.mkdir(input.caminhoCopia, { recursive: true });

    const maintenance = await decideMaintenance(input.manutencaoExplicita);
    await pool.query('UPDATE execucoes SET decisao_manutencao = $1, regra_aplicada = $2 WHERE id = $3', [maintenance.decisao, maintenance.regra, executionId]);
    await log(executionId, 'manutencao', `${maintenance.decisao}: ${maintenance.regra}`);
    if (maintenance.decisao === 'VACUUM') await pool.query('VACUUM');
    if (maintenance.decisao === 'VACUUM_FULL_ANALYZE') await pool.query('VACUUM FULL ANALYZE');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    currentFile = path.join(input.destino, `backup-${input.banco}-${stamp}.dump`);
    await log(executionId, 'backup', 'Gerando backup no destino principal.');
    const dump = pgDumpOptions(input.banco, currentFile);
    await run(process.env.PG_DUMP_PATH || 'pg_dump', dump.args, { env: dump.env });

    if (input.criptografia) {
      await log(executionId, 'criptografia', 'Criptografando backup com AES-256-GCM.');
      const encrypted = await encryptFile(currentFile);
      await fs.unlink(currentFile);
      currentFile = encrypted;
    }
    if (input.compactacao) {
      await log(executionId, 'compactacao', 'Compactando backup em ZIP protegido.');
      const compacted = await compactFile(currentFile);
      await fs.unlink(currentFile);
      currentFile = compacted;
    }
    await log(executionId, 'retencao', `Mantendo no máximo ${input.qtdManter} backup(s).`);
    await retainBackups(input.destino, input.banco, input.qtdManter, currentFile);
    if (input.caminhoCopia) {
      await log(executionId, 'copia_adicional', 'Copiando backup para o destino adicional.');
      await fs.copyFile(currentFile, path.join(input.caminhoCopia, path.basename(currentFile)));
    }
    const result = `Backup concluído: ${path.basename(currentFile)}`;
    await pool.query(`UPDATE execucoes SET status = 'sucesso', data_fim = now(), resultado = $1 WHERE id = $2`, [result, executionId]);
    await log(executionId, 'finalizacao', result);
    publish(executionId, 'concluida', { status: 'sucesso', resultado: result });
  } catch (error) {
    const message = 'Execução interrompida por falha. Consulte os logs da execução.';
    await pool.query(`UPDATE execucoes SET status = 'falha', data_fim = now(), resultado = $1 WHERE id = $2`, [message, executionId]).catch(() => {});
    await log(executionId, 'falha', message, error.message).catch(() => {});
    // Integração de e-mail fica concentrada aqui; não inclui segredos nem saída bruta.
    console.error(`Notificação simulada de falha da execução ${executionId}: ${redact(error.message)}`);
    publish(executionId, 'concluida', { status: 'falha', resultado: message });
  }
}

async function startExecution(body) {
  const input = normalizeInput(body);
  const config = await pool.query(
    `INSERT INTO configuracoes_backup (banco, caminho_destino, qtd_manter, caminho_copia, criptografar, compactar)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.banco, input.destino, input.qtdManter, input.caminhoCopia, input.criptografia, input.compactacao]
  );
  const execution = await pool.query(
    `INSERT INTO execucoes (config_id, status) VALUES ($1, 'em_andamento') RETURNING id, data_inicio, status`,
    [config.rows[0].id]
  );
  const item = execution.rows[0];
  setImmediate(() => execute(item.id, input));
  return item;
}

async function getExecution(id, includeLogs = true) {
  const execution = await pool.query(
    `SELECT e.id, e.data_inicio, e.data_fim, e.decisao_manutencao, e.regra_aplicada, e.status, e.resultado,
            c.banco, c.caminho_destino, c.qtd_manter, c.caminho_copia, c.criptografar, c.compactar
       FROM execucoes e JOIN configuracoes_backup c ON c.id = e.config_id WHERE e.id = $1`, [id]
  );
  if (!execution.rows[0]) return null;
  const response = execution.rows[0];
  if (includeLogs) {
    const logs = await pool.query('SELECT etapa, mensagem, data FROM logs_execucao WHERE execucao_id = $1 ORDER BY id', [id]);
    response.logs = logs.rows;
  }
  return response;
}

module.exports = { startExecution, getExecution };
