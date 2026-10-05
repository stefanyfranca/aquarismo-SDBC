/**
 * manutencao.js — Decisão de manutenção (antes do backup).
 *
 * Fontes da "última manutenção":
 *  A) histórico local da plataforma (tabela manutencoes);
 *  B) estatísticas do banco: GREATEST(max(last_vacuum), max(last_analyze))
 *     em pg_stat_user_tables (ignora autovacuum/autoanalyze);
 *  C) modo demonstração: data simulada que SUBSTITUI A e B.
 *
 * Regras (dias inteiros entre agora e a data):
 *  < 30            → não executar
 *  30..60          → VACUUM
 *  > 60            → VACUUM FULL ANALYZE
 *  sem data válida  → VACUUM FULL ANALYZE
 *
 * A escolha explícita do usuário prevalece sobre a decisão automática.
 */
const db = require('./db');

const LIMIAR_VACUUM = 30;
const LIMIAR_FULL = 60;

/** Parse robusto de data: aceita ISO (com 'Z') e formato SQLite ("YYYY-MM-DD HH:MM:SS"). */
function parseData(s) {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/** Dias inteiros entre a data e agora (floor). */
function diasDesde(data) {
  if (!data) return null;
  const d = data instanceof Date ? data : new Date(data);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Calcula a decisão de manutenção.
 * @param {object} opts
 * @param {string} opts.chaveConexao — host:porta/banco
 * @param {string|null} opts.escolhaExplicita — 'NENHUMA' | 'VACUUM' | 'VACUUM_FULL_ANALYZE' | null (automática)
 * @param {Date|null} opts.dataSimulada — data de referência do modo demonstração (substitui A/B)
 * @param {boolean} opts.demoAtivo
 * @param {Date|null} [fonteB] — data vinda de pg_stat_user_tables (opcional; se omitida, consulta)
 * @returns {{tipo: string, regra: string, origem: string, dias: number|null, fonteUsada: string|null}}
 */
function decidir({ chaveConexao, escolhaExplicita, dataSimulada, demoAtivo, fonteB = null }) {
  // Escolha explícita do usuário prevalece sobre a decisão automática.
  if (escolhaExplicita && escolhaExplicita !== 'AUTOMATICA') {
    const tipo = escolhaExplicita === 'NENHUMA' ? 'NENHUMA' : escolhaExplicita;
    const regra = `Escolha explícita do usuário (${tipo === 'NENHUMA' ? 'nenhuma manutenção' : tipo}); prevalece sobre a decisão automática.`;
    return { tipo, regra, origem: 'explicita', dias: null, fonteUsada: null };
  }

  // Modo demonstração: data simulada substitui as fontes A/B.
  // Se não houver data simulada, trata como "sem histórico".
  if (demoAtivo) {
    const dias = dataSimulada ? diasDesde(dataSimulada) : null;
    const { tipo, regra } = regraPorDias(dias);
    return {
      tipo,
      regra: `${regra} Decisão baseada em data SIMULADA (modo demonstração).`,
      origem: 'simulada',
      dias,
      fonteUsada: 'simulada',
    };
  }

  // Fonte A: histórico local.
  const man = db.ultimaManutencao(chaveConexao);
  const dataA = man?.fim ? parseData(man.fim) : null;
  // Fonte B: estatísticas do banco (passada pelo caller para evitar dependência circular).
  const dataB = fonteB || null;

  // Usa a mais recente entre A e B.
  let data = null;
  let fonteUsada = null;
  if (dataA && (!dataB || dataA >= dataB)) { data = dataA; fonteUsada = 'historico_local'; }
  else if (dataB) { data = dataB; fonteUsada = 'estatisticas_banco'; }

  const dias = diasDesde(data);
  const { tipo, regra } = regraPorDias(dias);
  const regraFinal = fonteUsada
    ? `${regra} (fonte: ${fonteUsada === 'historico_local' ? 'histórico local da plataforma' : 'estatísticas do banco (pg_stat_user_tables)'})`
    : regra;
  return { tipo, regra: regraFinal, origem: 'automatica', dias, fonteUsada };
}

function regraPorDias(dias) {
  if (dias === null) {
    return { tipo: 'VACUUM_FULL_ANALYZE', regra: 'Sem histórico de manutenção com data válida.' };
  }
  if (dias < LIMIAR_VACUUM) {
    return { tipo: 'NENHUMA', regra: `Última manutenção há ${dias} dias (< 30).` };
  }
  if (dias <= LIMIAR_FULL) {
    return { tipo: 'VACUUM', regra: `Última manutenção há ${dias} dias (entre 30 e 60).` };
  }
  return { tipo: 'VACUUM_FULL_ANALYZE', regra: `Última manutenção há ${dias} dias (> 60).` };
}

module.exports = { decidir, diasDesde, regraPorDias, LIMIAR_VACUUM, LIMIAR_FULL };
