const { appPool } = require("../database/pool");
const configService = require("./configService");
const progressBus = require("./progressBus");

/**
 * IMPORTANTE — leia antes de mexer neste arquivo:
 *
 * O fluxo REAL de manutenção/backup (validar, decidir manutenção — com a
 * escolha manual do usuário quando houver, gerar backup, criptografar,
 * compactar, aplicar retenção, copiar) é responsabilidade de quem
 * implementar a tela "Nova Execução". Este arquivo contém um SIMULADOR
 * que existe só para permitir testar o Dashboard (e a barra de progresso
 * via SSE) de ponta a ponta antes dessa parte estar pronta. Por isso ele
 * sempre usa a decisão AUTOMÁTICA de manutenção — a escolha manual não é
 * um dado desta tela.
 *
 * Quando o serviço real existir, ele deve:
 *   1) inserir a linha em `execucoes` (como startDemoExecution faz aqui),
 *      já considerando a conexão com o banco-alvo e a manutenção manual;
 *   2) chamar progressBus.publishProgress(executionId, {...}) a cada etapa;
 *   3) ao final, dar UPDATE em execucoes (status, data_fim, resultado)
 *      e chamar progressBus.publishDone(executionId, {...}).
 * O Dashboard não precisa de nenhuma alteração quando isso acontecer.
 */

// Guarda o progresso mais recente de cada execução em memória, para que
// o Dashboard veja o estado atual mesmo se a página for recarregada no
// meio de uma execução (o progresso em si não é persistido no banco).
const liveProgress = new Map(); // executionId -> { stepLabel, percent }

function decidirManutencaoAutomatica(dataUltimaExecucaoSucesso) {
  if (!dataUltimaExecucaoSucesso) {
    return { decisao: "VACUUM_FULL_ANALYZE", regra: "Sem execução anterior registrada." };
  }
  const dias = Math.floor((Date.now() - new Date(dataUltimaExecucaoSucesso)) / 86400000);
  if (dias < 30) return { decisao: "NENHUMA", regra: `Última manutenção há ${dias} dia(s) (< 30).` };
  if (dias <= 60) return { decisao: "VACUUM", regra: `Última manutenção há ${dias} dia(s) (30–60).` };
  return { decisao: "VACUUM_FULL_ANALYZE", regra: `Última manutenção há ${dias} dia(s) (> 60).` };
}

async function registrarLog(execucaoId, etapa, mensagem) {
  await appPool.query(
    `INSERT INTO logs_execucao (execucao_id, etapa, mensagem) VALUES ($1, $2, $3)`,
    [execucaoId, etapa, mensagem]
  );
}

async function getCurrentExecution() {
  // Filtra pela configuração ativa: uma execução que ficou presa em
  // "em_andamento" de outro banco não deve aparecer no Dashboard.
  const config = await configService.getConfig();
  if (!config) return null;

  const { rows } = await appPool.query(
    `SELECT id, data_inicio FROM execucoes
      WHERE config_id = $1 AND status = 'em_andamento'
      ORDER BY data_inicio DESC
      LIMIT 1`,
    [config.id]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const executionId = `EXEC-${row.id}`;
  const live = liveProgress.get(executionId);

  return {
    executionId,
    stepLabel: live?.stepLabel ?? "Processando…",
    percent: live?.percent ?? 0,
  };
}

/**
 * Dispara uma execução simulada usando a configuração ativa (apenas as
 * preferências de destino/retenção/criptografia/compactação — a conexão
 * com o banco-alvo e a manutenção manual não fazem parte deste fluxo de
 * demonstração). Serve só para validar o Dashboard de ponta a ponta.
 */
async function startDemoExecution() {
  const config = await configService.getConfig();
  if (!config) {
    const err = new Error("Nenhuma configuração salva. Configure o backup antes de executar.");
    err.status = 400;
    throw err;
  }

  const ultimaExecucao = await appPool.query(
    `SELECT data_inicio FROM execucoes
      WHERE status = 'sucesso' AND config_id = $1
      ORDER BY data_inicio DESC LIMIT 1`,
    [config.id]
  );

  const { decisao, regra } = decidirManutencaoAutomatica(ultimaExecucao.rows[0]?.data_inicio);

  const insert = await appPool.query(
    `INSERT INTO execucoes (config_id, decisao_manutencao, regra_aplicada, status)
     VALUES ($1, $2, $3, 'em_andamento')
     RETURNING id, data_inicio`,
    [config.id, decisao, regra]
  );

  const execucaoRow = insert.rows[0];
  const executionId = `EXEC-${execucaoRow.id}`;

  runSimulatedSteps(executionId, execucaoRow.id, config, decisao);

  return { executionId };
}

async function runSimulatedSteps(executionId, execucaoDbId, config, decisao) {
  const steps = [
    { key: "validacao", label: "Validando parâmetros de backup", percent: 12 },
    { key: "manutencao", label: `Aplicando manutenção (${decisao})`, percent: 28 },
    { key: "backup", label: "Gerando backup", percent: 50 },
  ];
  if (config.criptografar) steps.push({ key: "criptografia", label: "Criptografando arquivo (AES)", percent: 65 });
  if (config.compactar) steps.push({ key: "compactacao", label: "Compactando em ZIP protegido", percent: 78 });
  steps.push({ key: "retencao", label: "Aplicando política de retenção", percent: 88 });
  if (config.caminhoCopia) steps.push({ key: "copia", label: "Copiando para destino adicional", percent: 96 });
  steps.push({ key: "finalizacao", label: "Finalizando execução", percent: 100 });

  for (const step of steps) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    liveProgress.set(executionId, { stepLabel: step.label, percent: step.percent });
    progressBus.publishProgress(executionId, {
      executionId,
      step: step.key,
      stepLabel: step.label,
      percent: step.percent,
      status: "running",
    });
    await registrarLog(execucaoDbId, step.key, step.label).catch((e) =>
      console.error("Falha ao gravar log de execução:", e.message)
    );
  }

  await appPool.query(
    `UPDATE execucoes SET status = 'sucesso', data_fim = now(), resultado = 'Backup concluído com sucesso.'
     WHERE id = $1`,
    [execucaoDbId]
  );

  liveProgress.delete(executionId);
  progressBus.publishDone(executionId, { executionId, status: "success", message: "Backup concluído com sucesso." });
}

module.exports = { getCurrentExecution, startDemoExecution };
