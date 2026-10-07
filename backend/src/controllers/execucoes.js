/**
 * controllers/execucoes.js — Pré-checagens, decisão de manutenção, execuções,
 * restauração e os canais SSE de progresso.
 */
const db = require('../lib/db');
const conexao = require('../lib/conexao');
const manutencao = require('../services/manutencao');
const v = require('../lib/validacao');
const pgtools = require('../lib/pgtools');
const { Executor, ETAPAS_BLOQUEANTES } = require('../services/pipeline');
const { Restaurador } = require('../services/restauracao');
const { erro, chaveConexaoDe } = require('../lib/http');

/** Execuções ativas (para SSE e concorrência). */
const execucoesAtivas = new Map(); // execucaoId -> Executor
const restauracoesAtivas = new Map(); // execucaoId -> Restaurador
// Restaurações já terminadas: mantém a trilha de eventos para reenviar a
// clientes SSE que conectam depois do fim (a restauração não é persistida).
const restauracoesConcluidas = new Map(); // execucaoId -> [{nome, dados}]
const TTL_CONCLUIDAS_MS = 10 * 60 * 1000;

/* ------------------------------ validação ------------------------------ */

async function validar(req, res) {
  const p = req.body || {};
  const resultados = { conexao: false, permissoes: null, diretorios: [], ferramentas: null, erros: [] };

  // Ferramentas
  const ferramentas = pgtools.localizarTodas(p.pastaBin);
  resultados.ferramentas = {
    pg_dump: ferramentas.pg_dump?.caminho || null,
    pg_restore: ferramentas.pg_restore?.caminho || null,
  };
  if (!ferramentas.pg_dump) resultados.erros.push('pg_dump não encontrado.');
  if (!ferramentas.pg_restore) resultados.erros.push('pg_restore não encontrado.');

  // Conexão
  try {
    const pool = conexao.conectar(req.sessao, p.banco || req.sessao.banco);
    await pool.query('SELECT 1');
    resultados.conexao = true;
  } catch (e) {
    resultados.erros.push(`Conexão: ${e.message}`);
  }

  // Permissões
  try {
    resultados.permissoes = await conexao.verificarPermissoes(req.sessao);
    resultados.erros.push(...resultados.permissoes.erros);
  } catch (e) {
    resultados.erros.push(`Permissões: ${e.message}`);
  }

  // Diretórios
  const criar = p.criarDiretorio === true;
  {
    const e1 = v.validarCaminho(p.destino, { rotulo: 'Destino' });
    if (e1) resultados.erros.push(e1);
    else {
      const e2 = await v.verificarDiretorioGravavel(p.destino, { criar, rotulo: 'Diretório de destino' });
      if (e2) resultados.erros.push(e2);
      else resultados.diretorios.push(p.destino);
    }
  }
  if (p.copiaAdicional) {
    const e1 = v.validarCaminho(p.copiaAdicional, { rotulo: 'Cópia adicional' });
    if (e1) resultados.erros.push(e1);
    else {
      const e2 = await v.verificarDiretorioGravavel(p.copiaAdicional, { criar, rotulo: 'Diretório de cópia adicional' });
      if (e2) resultados.erros.push(e2);
      else resultados.diretorios.push(p.copiaAdicional);
    }
  }

  res.json({ ok: resultados.erros.length === 0, ...resultados });
}

/**
 * Monta a decisão de manutenção com base na sessão, na configuração e nas
 * estatísticas reais do banco (ou na data simulada do modo demonstração).
 */
async function decidirCom(req, { escolhaManutencao, demoAtivo, demoDataSimulada }) {
  const chave = chaveConexaoDe(req.sessao);
  const cfg = db.getConfiguracao(chave) || {};
  const demo = demoAtivo ?? !!cfg.demo_ativo;
  const dataSim = demoDataSimulada ?? cfg.demo_data_manutencao ?? null;

  let fonteB = null;
  if (!demo || !dataSim) {
    try {
      fonteB = await conexao.ultimaManutencaoEstatisticas(req.sessao);
    } catch { /* sem estatísticas */ }
  }
  return manutencao.decidir({
    chaveConexao: chave,
    escolhaExplicita: escolhaManutencao || 'AUTOMATICA',
    dataSimulada: demo && dataSim ? new Date(dataSim) : null,
    demoAtivo: demo,
    fonteB,
  });
}

/* ------------------------------- decisão ------------------------------- */

async function decisao(req, res) {
  const { escolhaManutencao, demoDataSimulada, demoAtivo } = req.body || {};
  const d = await decidirCom(req, { escolhaManutencao, demoDataSimulada, demoAtivo });
  res.json({ ...d, bloqueante: ETAPAS_BLOQUEANTES.has(d.tipo) });
}

/* ------------------------------ execuções ------------------------------ */

async function iniciar(req, res) {
  const p = req.body || {};
  const s = req.sessao;

  // Concorrência: apenas uma execução por conexão/banco por vez.
  const chave = chaveConexaoDe(s);
  for (const [id, ex] of execucoesAtivas) {
    if (ex.sessao === s && ex.params.banco === p.banco && ex.execucaoId === id) {
      return erro(res, 409, 'Já há uma execução em andamento para este banco. Aguarde a conclusão.');
    }
  }

  // Validações básicas (destino é obrigatório mesmo quando não informado).
  const errs = [v.validarBanco(p.banco), v.validarCaminho(p.destino, { rotulo: 'Destino' })].filter(Boolean);
  if (errs.length) return erro(res, 400, errs.join(' '));

  // Decisão de manutenção.
  const cfg = db.getConfiguracao(chave) || {};
  const demo = p.demoAtivo ?? !!cfg.demo_ativo;
  const dataSim = p.demoDataSimulada ?? cfg.demo_data_manutencao ?? null;
  let fonteB = null;
  if (!demo || !dataSim) {
    try { fonteB = await conexao.ultimaManutencaoEstatisticas(s); } catch { /* ok */ }
  }
  const decisao = manutencao.decidir({
    chaveConexao: chave,
    escolhaExplicita: p.escolhaManutencao || 'AUTOMATICA',
    dataSimulada: demo && dataSim ? new Date(dataSim) : null,
    demoAtivo: demo,
    fonteB,
  });

  // Se for bloqueante (VACUUM FULL ANALYZE) e não houve confirmação, retorna 409.
  if (ETAPAS_BLOQUEANTES.has(decisao.tipo) && !p.confirmar) {
    return res.status(409).json({
      erro: 'Esta execução requer confirmação: VACUUM FULL ANALYZE bloqueia as tabelas durante a execução.',
      decisao,
      requerConfirmacao: true,
    });
  }

  // Inicia de forma assíncrona (não bloqueia a resposta).
  const executor = new Executor(s, {
    banco: p.banco,
    destino: p.destino,
    quantidadeManter: p.quantidadeManter,
    copiaAdicional: p.copiaAdicional,
    criarDiretorio: p.criarDiretorio === true,
    compactar: !!p.compactar,
    criptografar: !!p.criptografar,
    chaveAes: p.chaveAes,
    senhaZip: p.senhaZip,
    escolhaManutencao: p.escolhaManutencao,
    simularFalha: !!p.simularFalha,
    demoDataSimulada: demo && dataSim ? dataSim : null,
    pastaBin: p.pastaBin ?? cfg.pasta_bin,
  }, decisao);

  // Registra para SSE e concorrência (o id é gerado no início de executar()).
  const aguardarId = new Promise(resolve => executor.once('inicio', e => resolve(e.id)));
  const promessa = executor.executar();
  const id = await aguardarId;
  execucoesAtivas.set(id, executor);
  promessa.finally(() => execucoesAtivas.delete(id));

  res.status(202).json({ id, mensagem: 'Execução iniciada.', decisao });
}

function listar(req, res) {
  const { status, dias, banco } = req.query;
  const chave = chaveConexaoDe(req.sessao);
  const rows = db.listarExecucoes({ status, dias: dias ? Number(dias) : undefined, chave });
  res.json({ execucoes: rows });
}

function detalhar(req, res) {
  const ex = db.buscarExecucao(Number(req.params.id));
  if (!ex) return erro(res, 404, 'Execução não encontrada.');
  res.json({ execucao: ex, logs: db.logsDaExecucao(ex.id) });
}

/* --------------------------------- SSE --------------------------------- */

/**
 * Escreve um evento SSE ignorando respostas já encerradas/destruídas
 * (o navegador pode reconectar ou fechar a aba no meio da execução).
 */
function escritorSse(res) {
  return (evento, dados) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
    return true;
  };
}

function cabecalhosSse(res, { bufferizacao = false } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(bufferizacao ? { 'X-Accel-Buffering': 'no' } : {}),
  });
  res.write(`retry: 3000\n\n`);
}

function eventos(req, res) {
  const id = Number(req.params.id);
  const ex = db.buscarExecucao(id);
  if (!ex) return erro(res, 404, 'Execução não encontrada.');

  cabecalhosSse(res, { bufferizacao: true });
  const enviar = escritorSse(res);

  // Reenvia o estado atual ao (re)conectar.
  enviar('estado', {
    id: ex.id,
    status: ex.status,
    etapa_falha: ex.etapa_falha,
    resultado: ex.resultado,
    arquivo_final: ex.arquivo_final,
  });

  const executor = execucoesAtivas.get(id);
  if (!executor || ex.status !== 'andamento') {
    // Execução já terminou: envia fim e encerra.
    enviar('fim', { status: ex.status });
    return res.end();
  }

  const aoEvento = (etapa) => enviar('etapa', etapa);
  const aoLog = (log) => enviar('log', log);
  const aoFim = () => {
    const atual = db.buscarExecucao(id);
    enviar('fim', { status: atual?.status || ex.status });
    res.end();
  };

  const desligar = () => {
    executor.off('etapa', aoEvento);
    executor.off('log', aoLog);
    executor.off('fim', aoFim);
  };

  executor.on('etapa', aoEvento);
  executor.on('log', aoLog);
  executor.on('fim', aoFim);

  req.on('close', desligar);
  res.on('close', desligar);
}

/* ----------------------------- restauração ----------------------------- */

function restaurar(req, res) {
  const ex = db.buscarExecucao(Number(req.params.id));
  if (!ex) return erro(res, 404, 'Execução não encontrada.');
  if (ex.status !== 'sucesso' || !ex.arquivo_final) {
    return erro(res, 400, 'Só é possível restaurar execuções concluídas com sucesso.');
  }
  const b = req.body || {};
  if (!b.bancoDestino) return erro(res, 400, 'Informe o nome do banco de destino da restauração.');
  const erroBanco = v.validarBanco(b.bancoDestino);
  if (erroBanco) return erro(res, 400, erroBanco);
  if (b.bancoDestino === ex.parametros?.banco) {
    return erro(res, 400, 'Nunca é permitido restaurar sobre o banco original. Escolha outro destino.');
  }

  const s = req.sessao;
  const cfg = db.getConfiguracao(ex.chave_conexao) || {};
  const restaurador = new Restaurador(s, {
    arquivo: ex.arquivo_final,
    bancoDestino: b.bancoDestino,
    bancoOrigem: ex.parametros?.banco,
    chaveAes: b.chaveAes,
    senhaZip: b.senhaZip,
    recriarSeExistir: !!b.recriarSeExistir,
    somenteContagem: !!b.somenteContagem,
    pastaBin: b.pastaBin ?? cfg.pasta_bin,
  });

  const id = ex.id;
  const aguardarPronto = new Promise(resolve => restaurador.once('fim', r => resolve(r)));
  restaurador.executar();
  restauracoesAtivas.set(id, restaurador);
  aguardarPronto.finally(() => {
    restauracoesAtivas.delete(id);
    restauracoesConcluidas.set(id, restaurador.historico);
    const timer = setTimeout(() => restauracoesConcluidas.delete(id), TTL_CONCLUIDAS_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });

  res.status(202).json({ mensagem: 'Restauração iniciada. Acompanhe o progresso via SSE.' });
}

function eventosRestauracao(req, res) {
  const id = Number(req.params.id);
  cabecalhosSse(res);
  const enviar = escritorSse(res);

  const r = restauracoesAtivas.get(id);
  const historico = r ? r.historico : restauracoesConcluidas.get(id);
  if (!historico) {
    enviar('fim', { status: 'nao_encontrado' });
    return res.end();
  }

  // Reenvia tudo o que já aconteceu (fecha a janela entre o POST e a abertura
  // do EventSource). O laço é síncrono: nenhum evento ao vivo escapa entre o
  // reenvio e a associação dos listeners abaixo.
  let concluido = false;
  for (const ev of historico) {
    if (ev.nome === 'fim') concluido = true;
    enviar(ev.nome, ev.dados);
  }
  if (concluido) return res.end();
  if (!r) {
    enviar('fim', { status: 'nao_encontrado' });
    return res.end();
  }

  const aoEtapa = e => enviar('etapa', e);
  const aoLog = l => enviar('log', l);
  const aoIntegridade = i => enviar('integridade', i);
  const aoFim = f => {
    enviar('fim', f);
    res.end();
  };
  r.on('etapa', aoEtapa);
  r.on('log', aoLog);
  r.on('integridade', aoIntegridade);
  r.on('fim', aoFim);

  const desligar = () => {
    r.off('etapa', aoEtapa);
    r.off('log', aoLog);
    r.off('integridade', aoIntegridade);
    r.off('fim', aoFim);
  };
  req.on('close', desligar);
  res.on('close', desligar);
}

module.exports = {
  validar, decisao, iniciar, listar, detalhar, eventos,
  restaurar, eventosRestauracao,
  execucoesAtivas, restauracoesAtivas,
};