const { appPool } = require("../database/pool");
const configService = require("./configService");

/**
 * Filtro reaproveitado em todas as consultas de execucoes: tudo é contado
 * só para a configuração ativa (o banco que o SBAC está atendendo agora).
 * Sem isso, apontar o sistema para outro banco misturaria as execuções do
 * banco anterior com as do novo. Se não houver configuração, o filtro não
 * casa com nada e os cards ficam zerados em vez de mostrarem dado antigo.
 */
const SOMENTE_CONFIG_ATIVA = `($1::int IS NOT NULL AND config_id = $1)`;

function formatDateTime(date) {
  if (!date) return null;
  return new Date(date).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(inicio, fim) {
  if (!inicio || !fim) return null;
  const ms = new Date(fim) - new Date(inicio);
  const totalSeconds = Math.round(ms / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return min > 0 ? `${min} min ${sec} s` : `${sec} s`;
}

async function getSummary() {
  const config = await configService.getConfig();
  const configId = config?.id ?? null;

  const [thisMonth, lastMonth, lastExecution, runningCount] = await Promise.all([
    appPool.query(
      `SELECT COUNT(*)::int AS total FROM execucoes
       WHERE ${SOMENTE_CONFIG_ATIVA}
         AND date_trunc('month', data_inicio) = date_trunc('month', now())`,
      [configId]
    ),
    appPool.query(
      `SELECT COUNT(*)::int AS total FROM execucoes
       WHERE ${SOMENTE_CONFIG_ATIVA}
         AND date_trunc('month', data_inicio) = date_trunc('month', now() - interval '1 month')`,
      [configId]
    ),
    appPool.query(
      `SELECT * FROM execucoes
       WHERE ${SOMENTE_CONFIG_ATIVA} AND status != 'em_andamento'
       ORDER BY data_inicio DESC LIMIT 1`,
      [configId]
    ),
    appPool.query(
      `SELECT COUNT(*)::int AS total FROM execucoes
       WHERE ${SOMENTE_CONFIG_ATIVA} AND status = 'em_andamento'`,
      [configId]
    ),
  ]);

  const count = thisMonth.rows[0].total;
  const diff = count - lastMonth.rows[0].total;
  const last = lastExecution.rows[0];
  const qtdManter = config?.quantidadeManter ?? null;
  const isRunning = runningCount.rows[0].total > 0;

  return {
    systemStatus: last?.status === "falha" ? "warn" : "ok",

    backupsThisMonth: count,
    backupsThisMonthHint:
      diff === 0 ? "igual ao mês anterior" : `${Math.abs(diff)} a ${diff > 0 ? "mais" : "menos"} que no mês anterior`,

    lastResult: last
      ? {
          label: last.status === "sucesso" ? "Sucesso" : "Falha",
          tone: last.status === "sucesso" ? "ok" : "error",
          hint: last.status === "sucesso"
            ? `Concluído em ${formatDuration(last.data_inicio, last.data_fim) ?? "—"}`
            : last.resultado || "Verifique o log da execução.",
        }
      : { label: "—", tone: "ok", hint: "Nenhuma execução registrada ainda." },

    // Não há tabela de agendamento no schema ainda; a tela "Nova Execução"
    // deve fornecer isso quando o agendamento for implementado.
    nextRun: { label: "Não agendado", hint: "Defina um agendamento em Nova Execução" },

    overview: {
      // Deixa explícito qual banco está sendo atendido agora, para não
      // confundir o backup do SBAC com o de outro banco plugged depois.
      alvo: config?.banco ?? null,
      lastRun: last ? formatDateTime(last.data_inicio) : "—",
      retention: qtdManter ? `${qtdManter} backups mantidos` : "Não definida",
      stateText: isRunning
        ? "Executando backup e aguardando a conclusão da rotina."
        : "Sistema ocioso, aguardando a próxima execução.",
      stateLabel: isRunning ? "Em execução" : "Operacional",
      stateTone: isRunning ? "running" : "ok",
    },
  };
}

module.exports = { getSummary };
