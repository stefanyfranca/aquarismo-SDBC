const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { pool } = require('../database/pool');
const { publish } = require('./execution-events');
const { caminhoFerramenta, argumentosConexao, ambienteFilho } = require('./postgres-tools');
const criptografia = require('./criptografia.service');
const zip = require('./zip.service');

const MANUTENCOES = {
  none: 'NENHUMA',
  vacuum: 'VACUUM',
  vacuum_full_analyze: 'VACUUM_FULL_ANALYZE'
};

const CENARIOS_DEMONSTRACAO = {
  menos_30: { nome: 'Menos de 30 dias', dias: 7 },
  entre_30_60: { nome: 'Entre 30 e 60 dias', dias: 45 },
  acima_60: { nome: 'Acima de 60 dias', dias: 75 },
  sem_historico: { nome: 'Ausencia de historico', dias: null }
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
  if (body.simular_falha !== undefined && typeof body.simular_falha !== 'boolean') {
    throw validationError('simular_falha deve ser booleano.');
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
    simularFalha: body.simular_falha === true,
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

function maintenanceDecision(dataFim, now = Date.now()) {
  if (!dataFim) return { decisao: 'VACUUM_FULL_ANALYZE', regra: 'Sem historico de manutencao com data valida.', dias: null };
  const days = (now - new Date(dataFim).getTime()) / 86400000;
  if (days < 30) return { decisao: 'NENHUMA', regra: `Ultima manutencao ha ${days.toFixed(1)} dias (< 30).`, dias: Number(days.toFixed(2)) };
  if (days <= 60) return { decisao: 'VACUUM', regra: `Ultima manutencao ha ${days.toFixed(1)} dias (entre 30 e 60).`, dias: Number(days.toFixed(2)) };
  return { decisao: 'VACUUM_FULL_ANALYZE', regra: `Ultima manutencao ha ${days.toFixed(1)} dias (> 60).`, dias: Number(days.toFixed(2)) };
}

async function decideMaintenance(explicit, testScenario) {
  let lastMaintenance;
  if (testScenario) {
    lastMaintenance = testScenario.data_ultima_manutencao;
  } else {
    const { rows } = await pool.query(
      `SELECT data_fim FROM execucoes
     WHERE status = 'sucesso'
       AND decisao_manutencao IN ('VACUUM', 'VACUUM_ANALYZE', 'VACUUM_FULL_ANALYZE')
       AND data_fim IS NOT NULL
     ORDER BY data_fim DESC LIMIT 1`
    );
    lastMaintenance = rows[0]?.data_fim;
  }
  const automatic = maintenanceDecision(lastMaintenance);
  return {
    ...automatic,
    decisao: explicit ? MANUTENCOES[explicit] : automatic.decisao,
    regra: explicit ? `Escolha manual do usuario (${MANUTENCOES[explicit]}).` : automatic.regra,
    historicoEm: lastMaintenance || null
  };
}

async function prepareMaintenanceScenario(key) {
  const scenario = CENARIOS_DEMONSTRACAO[key];
  if (!scenario) throw validationError('Cenario de demonstracao invalido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE cenarios_demonstracao_manutencao SET consumido_em = now() WHERE consumido_em IS NULL');
    const id = crypto.randomUUID();
    const historicalDate = scenario.dias === null ? null : new Date(Date.now() - scenario.dias * 86400000);
    const { rows } = await client.query(
      `INSERT INTO cenarios_demonstracao_manutencao (id, chave, data_ultima_manutencao)
       VALUES ($1, $2, $3) RETURNING id, chave, data_ultima_manutencao, preparado_em`, [id, key, historicalDate]
    );
    await client.query('COMMIT');
    return { ...rows[0], nome: scenario.nome };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function getPreparedMaintenanceScenario() {
  const { rows } = await pool.query(
    `SELECT id, chave, data_ultima_manutencao, preparado_em FROM cenarios_demonstracao_manutencao
      WHERE consumido_em IS NULL ORDER BY preparado_em DESC LIMIT 1`
  );
  const scenario = rows[0];
  return scenario ? { ...scenario, nome: CENARIOS_DEMONSTRACAO[scenario.chave]?.nome || scenario.chave } : null;
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

function pgDumpOptions(banco, output) {
  const args = ['--format=custom', '--file', output, '--dbname', banco, ...argumentosConexao()];
  // PGPASSWORD é passado somente ao processo filho, sem ser incluído nos argumentos ou logs.
  return { args, env: ambienteFilho() };
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
    if (input.testScenario) {
      const preparedAt = input.testScenario.data_ultima_manutencao
        ? new Date(input.testScenario.data_ultima_manutencao).toISOString() : 'sem data (sem historico)';
      await log(executionId, 'cenario_demonstracao', `Cenario: ${input.testScenario.nome}; ultima manutencao preparada: ${preparedAt}.`);
    }
    await fs.mkdir(input.destino, { recursive: true });
    if (input.caminhoCopia) await fs.mkdir(input.caminhoCopia, { recursive: true });
    if (input.simularFalha) throw new Error('Falha controlada solicitada para validar o registro e a notificacao de erro.');

    const maintenance = await decideMaintenance(input.manutencaoExplicita, input.testScenario);
    await pool.query(
      `UPDATE execucoes SET decisao_manutencao = $1, regra_aplicada = $2,
              historico_manutencao_em = $3, dias_desde_manutencao = $4 WHERE id = $5`,
      [maintenance.decisao, maintenance.regra, maintenance.historicoEm, maintenance.dias, executionId]
    );
    await log(executionId, 'manutencao', `${maintenance.decisao}: ${maintenance.regra}`);
    if (maintenance.decisao === 'VACUUM') await pool.query('VACUUM');
    if (maintenance.decisao === 'VACUUM_FULL_ANALYZE') await pool.query('VACUUM FULL ANALYZE');
    const executed = maintenance.decisao;
    await pool.query('UPDATE execucoes SET manutencao_executada = $1 WHERE id = $2', [executed, executionId]);
    await log(executionId, 'manutencao_executada', executed === 'NENHUMA'
      ? 'Nenhuma manutencao executada por decisao NENHUMA.'
      : `${executed} executado com sucesso.`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    currentFile = path.join(input.destino, `backup-${input.banco}-${stamp}.dump`);
    await pool.query('UPDATE execucoes SET caminho_arquivo_backup = $1 WHERE id = $2', [currentFile, executionId]);
    await log(executionId, 'backup', 'Gerando backup no destino principal.');
    const dump = pgDumpOptions(input.banco, currentFile);
    await run(caminhoFerramenta('pg_dump'), dump.args, { env: dump.env });

    if (input.criptografia) {
      await log(executionId, 'criptografia', 'Criptografando backup com AES-256-GCM.');
      const encrypted = `${currentFile}.aes`;
      await criptografia.criptografarArquivo(currentFile, encrypted);
      await fs.unlink(currentFile);
      currentFile = encrypted;
    }
    if (input.compactacao) {
      await log(executionId, 'compactacao', 'Compactando backup em ZIP protegido.');
      const compacted = `${currentFile}.zip`;
      await zip.compactarProtegido(currentFile, compacted);
      await fs.unlink(currentFile);
      currentFile = compacted;
    }
    await log(executionId, 'retencao', `Mantendo no máximo ${input.qtdManter} backup(s).`);
    await retainBackups(input.destino, input.banco, input.qtdManter, currentFile);
    if (input.caminhoCopia) {
      await log(executionId, 'copia_adicional', 'Copiando backup para o destino adicional.');
      const copyFile = path.join(input.caminhoCopia, path.basename(currentFile));
      await fs.copyFile(currentFile, copyFile);
      await retainBackups(input.caminhoCopia, input.banco, input.qtdManter, copyFile);
    }
    const result = `Backup concluído: ${path.basename(currentFile)}`;
    await pool.query(`UPDATE execucoes SET status = 'sucesso', data_fim = now(), resultado = $1, caminho_arquivo_backup = $2 WHERE id = $3`, [result, currentFile, executionId]);
    await log(executionId, 'finalizacao', result);
    publish(executionId, 'concluida', { status: 'sucesso', resultado: result });
  } catch (error) {
    const message = 'Execução interrompida por falha. Consulte os logs da execução.';
    await pool.query(`UPDATE execucoes SET status = 'falha', data_fim = now(), resultado = $1 WHERE id = $2`, [message, executionId]).catch(() => {});
    const technical = JSON.stringify({ erro: redact(error.message), banco: input.banco, destino: input.destino,
      caminho_copia_adicional: input.caminhoCopia, qtd_manter: input.qtdManter,
      compactacao: input.compactacao, criptografia: input.criptografia,
      etapa: input.simularFalha ? 'falha_controlada' : 'execucao' });
    await log(executionId, 'falha', message, technical).catch(() => {});
    await log(executionId, 'notificacao', `Notificacao por e-mail simulada para a execucao ${executionId}.`,
      `Falha: ${redact(error.message)}; detalhes gravados em logs_execucao.`).catch(() => {});
    // Integração de e-mail fica concentrada aqui; não inclui segredos nem saída bruta.
    console.error(`Notificação simulada de falha da execução ${executionId}: ${redact(error.message)}`);
    publish(executionId, 'concluida', { status: 'falha', resultado: message });
  }
}

async function startExecution(body) {
  const input = normalizeInput(body);
  const client = await pool.connect();
  let item;
  try {
    await client.query('BEGIN');
    let scenario = null;
    if (body.cenario_teste_id) {
      const { rows } = await client.query(
        `SELECT id, chave, data_ultima_manutencao FROM cenarios_demonstracao_manutencao
          WHERE id = $1 AND consumido_em IS NULL FOR UPDATE`, [body.cenario_teste_id]
      );
      if (!rows[0]) throw validationError('O cenario preparado expirou ou ja foi usado. Prepare novamente.');
      scenario = { ...rows[0], nome: CENARIOS_DEMONSTRACAO[rows[0].chave]?.nome || rows[0].chave };
    }
    const config = await client.query(
      `INSERT INTO configuracoes_backup (banco, caminho_destino, qtd_manter, caminho_copia, criptografar, compactar)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.banco, input.destino, input.qtdManter, input.caminhoCopia, input.criptografia, input.compactacao]
    );
    const execution = await client.query(
      `INSERT INTO execucoes
         (config_id, status, cenario_demonstracao_id, cenario_demonstracao, historico_manutencao_em)
       VALUES ($1, 'em_andamento', $2, $3, $4) RETURNING id, data_inicio, status`,
      [config.rows[0].id, scenario?.id || null, scenario?.nome || null, scenario?.data_ultima_manutencao || null]
    );
    item = execution.rows[0];
    if (scenario) {
      input.testScenario = scenario;
      await client.query(
        'UPDATE cenarios_demonstracao_manutencao SET consumido_em = now(), execucao_id = $1 WHERE id = $2',
        [item.id, scenario.id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  setImmediate(() => execute(item.id, input));
  return item;
}

async function getExecution(id, includeLogs = true) {
  const execution = await pool.query(
    `SELECT e.id, e.data_inicio, e.data_fim, e.decisao_manutencao, e.regra_aplicada, e.status, e.resultado,
            e.cenario_demonstracao_id, e.cenario_demonstracao, e.historico_manutencao_em,
            e.dias_desde_manutencao, e.manutencao_executada, e.caminho_arquivo_backup,
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

async function listExecutions(filters = {}) {
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 200));
  const params = [limit];
  const where = [];
  if (filters.status && ['sucesso', 'falha', 'em_andamento'].includes(filters.status)) {
    params.push(filters.status); where.push(`e.status = $${params.length}`);
  }
  if (filters.banco && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(filters.banco)) {
    params.push(filters.banco); where.push(`c.banco = $${params.length}`);
  }
  const days = Number(filters.dias);
  if (Number.isInteger(days) && days > 0 && days <= 3650) {
    params.push(days); where.push(`e.data_inicio >= now() - ($${params.length}::int * interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT e.id, e.data_inicio, e.data_fim, e.decisao_manutencao, e.regra_aplicada, e.status, e.resultado,
            e.cenario_demonstracao_id, e.cenario_demonstracao, e.historico_manutencao_em,
            e.dias_desde_manutencao, e.manutencao_executada, e.caminho_arquivo_backup,
            c.banco, c.caminho_destino, c.qtd_manter, c.caminho_copia, c.criptografar, c.compactar
       FROM execucoes e JOIN configuracoes_backup c ON c.id = e.config_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.data_inicio DESC, e.id DESC LIMIT $1`, params
  );
  return rows;
}

async function getBackupConfig() {
  const { rows } = await pool.query(
    `SELECT banco, caminho_destino, qtd_manter, caminho_copia, criptografar, compactar
       FROM configuracoes_backup ORDER BY id DESC LIMIT 1`
  );
  const config = rows[0];
  const roots = (process.env.BACKUP_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean).map((root) => path.resolve(root));
  const isAllowed = (directory) => {
    if (!directory || !roots.length) return false;
    const resolved = path.resolve(directory);
    return roots.some((root) => {
      const relative = path.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  };
  if (config && (!process.env.DB_NAME || config.banco === process.env.DB_NAME)
      && isAllowed(config.caminho_destino)
      && (!config.caminho_copia || isAllowed(config.caminho_copia))) return {
    banco: config.banco,
    destino: config.caminho_destino,
    qtd_manter: config.qtd_manter,
    caminho_copia_adicional: config.caminho_copia,
    criptografia: config.criptografar,
    compactacao: config.compactar
  };
  return {
    banco: process.env.DB_NAME || '',
    destino: process.env.BACKUP_DEFAULT_DESTINATION || '',
    qtd_manter: 7,
    caminho_copia_adicional: '',
    criptografia: false,
    compactacao: false
  };
}

async function saveBackupConfig(body) {
  const input = normalizeInput(body);
  await pool.query(
    `INSERT INTO configuracoes_backup (banco, caminho_destino, qtd_manter, caminho_copia, criptografar, compactar)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.banco, input.destino, input.qtdManter, input.caminhoCopia, input.criptografia, input.compactacao]
  );
  return getBackupConfig();
}

module.exports = { startExecution, getExecution, listExecutions, getBackupConfig, saveBackupConfig, maintenanceDecision,
  prepareMaintenanceScenario, getPreparedMaintenanceScenario, registrarEvento: log };
