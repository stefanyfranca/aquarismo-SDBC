/**
 * rotas.js — Rotas da API REST e SSE.
 *
 * Contrato (conforme enunciado):
 *   POST /api/conexao/testar      — testa credenciais
 *   POST /api/conexao             — conecta (cria sessão)
 *   DELETE /api/conexao           — desconecta (destrói sessão e pools)
 *   GET  /api/conexao/estado      — estado real (healthcheck SELECT 1)
 *   GET  /api/bancos              — lista bancos disponíveis
 *   POST /api/bancos/selecionar — troca o banco da sessão
 *   GET|PUT /api/configuracao     — configurações por conexão
 *   POST /api/validar             — testa conexão, permissões e diretórios
 *   POST /api/decisao             — prévia da decisão de manutenção
 *   POST /api/execucoes           — inicia execução (202 + id; 409 se bloqueante)
 *   GET  /api/execucoes           — histórico com filtros
 *   GET  /api/execucoes/:id       — detalhe
 *   GET  /api/execucoes/:id/eventos — SSE (reenvia estado ao conectar)
 *   POST /api/execucoes/:id/restaurar — restaura e confere integridade
 *   GET  /api/logs                — logs com filtros
 *   GET  /api/demo                — estado do modo demonstração
 *   PUT  /api/demo                — ativa/desativa e define data simulada
 *
 * Todas (exceto /api/conexao*) exigem sessão válida.
 * Erros sempre JSON {erro: "mensagem clara"}.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const sessao = require('./sessao');
const conexao = require('./conexao');
const manutencao = require('./manutencao');
const v = require('./validacao');
const pgtools = require('./pgtools');
const { Executor, ETAPAS, ETAPAS_BLOQUEANTES } = require('./pipeline');
const { Restaurador } = require('./restauracao');

const router = express.Router();

/** Execuções ativas (para SSE e concorrência). */
const execucoesAtivas = new Map(); // execucaoId -> Executor
const restauracoesAtivas = new Map(); // execucaoId -> Restaurador

/* ------------------------------ helpers ------------------------------- */

function erro(res, status, msg) {
  return res.status(status).json({ erro: msg });
}

function chaveConexaoDe(sessao) {
  return `${sessao.host}:${sessao.porta}/${sessao.banco}`;
}

/* ------------------------------- conexão ------------------------------- */

router.post('/conexao/testar', async (req, res) => {
  const { host, porta, usuario, senha, banco, ssl } = req.body || {};
  const errs = [v.validarHost(host), v.validarPorta(porta), v.validarUsuario(usuario)].filter(Boolean);
  if (errs.length) return erro(res, 400, errs.join(' '));
  if (!senha) return erro(res, 400, 'Senha é obrigatória.');
  try {
    await conexao.testarConexao({ host, porta, usuario, senha, banco, ssl });
    res.json({ ok: true, mensagem: 'Conexão bem-sucedida.' });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

router.post('/conexao', async (req, res) => {
  const { host, porta, usuario, senha, banco, ssl } = req.body || {};
  const errs = [v.validarHost(host), v.validarPorta(porta), v.validarUsuario(usuario)].filter(Boolean);
  if (errs.length) return erro(res, 400, errs.join(' '));
  if (!senha) return erro(res, 400, 'Senha é obrigatória.');
  try {
    await conexao.testarConexao({ host, porta, usuario, senha, banco, ssl });
    const token = sessao.criarSessao({ host, porta, usuario, senha, banco, ssl });
    res.cookie(sessao.COOKIE_NAME, token, sessao.cookieOptions());
    res.json({ ok: true, mensagem: 'Conectado com sucesso.' });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

router.delete('/conexao', (req, res) => {
  const token = sessao.extrairToken(req);
  sessao.destruirSessao(token);
  res.clearCookie(sessao.COOKIE_NAME, { path: '/' });
  res.json({ ok: true, mensagem: 'Desconectado.' });
});

router.get('/conexao/estado', sessao.exigirSessao, async (req, res) => {
  try {
    const ok = await conexao.healthcheck(req.sessao);
    res.json({
      conectado: ok,
      host: req.sessao.host,
      porta: req.sessao.porta,
      usuario: req.sessao.usuario,
      banco: req.sessao.banco,
    });
  } catch {
    res.json({ conectado: false, host: req.sessao.host, porta: req.sessao.porta, usuario: req.sessao.usuario, banco: req.sessao.banco });
  }
});

router.get('/bancos', sessao.exigirSessao, async (req, res) => {
  try {
    const bancos = await conexao.listarBancos(req.sessao);
    res.json({ bancos });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

router.post('/bancos/selecionar', sessao.exigirSessao, async (req, res) => {
  const { banco } = req.body || {};
  const erroBanco = v.validarBanco(banco);
  if (erroBanco) return erro(res, 400, erroBanco);
  try {
    const pool = conexao.conectar(req.sessao, banco);
    await pool.query('SELECT 1');
    res.json({ ok: true, banco });
  } catch (e) {
    erro(res, 400, `Não foi possível selecionar o banco "${banco}": ${e.message}`);
  }
});

/* ---------------------------- configuração ----------------------------- */

router.get('/configuracao', sessao.exigirSessao, (req, res) => {
  const cfg = db.getConfiguracao(chaveConexaoDe(req.sessao)) || {};
  res.json(cfg);
});

router.put('/configuracao', sessao.exigirSessao, (req, res) => {
  const b = req.body || {};
  const chave = chaveConexaoDe(req.sessao);
  const atual = db.getConfiguracao(chave) || {};
  const nova = {
    chave_conexao: chave,
    destino: b.destino ?? atual.destino ?? null,
    quantidade_manter: b.quantidadeManter ?? atual.quantidade_manter ?? null,
    copia_adicional: b.copiaAdicional ?? atual.copia_adicional ?? null,
    compactar: b.compactar ?? atual.compactar ?? 0,
    criptografar: b.criptografar ?? atual.criptografar ?? 0,
    pasta_bin: b.pastaBin ?? atual.pasta_bin ?? null,
    email_alerta: b.emailAlerta ?? atual.email_alerta ?? null,
    smtp_host: b.smtpHost ?? atual.smtp_host ?? null,
    smtp_porta: b.smtpPorta ?? atual.smtp_porta ?? null,
    smtp_usuario: b.smtpUsuario ?? atual.smtp_usuario ?? null,
    demo_ativo: b.demoAtivo ?? atual.demo_ativo ?? 0,
    demo_data_manutencao: b.demoDataManutencao ?? atual.demo_data_manutencao ?? null,
  };
  // Valida caminhos se presentes.
  if (nova.destino) {
    const e = v.validarCaminho(nova.destino, { rotulo: 'Destino' });
    if (e) return erro(res, 400, e);
  }
  if (nova.copia_adicional) {
    const e = v.validarCaminho(nova.copia_adicional, { rotulo: 'Cópia adicional' });
    if (e) return erro(res, 400, e);
  }
  db.salvarConfiguracao(nova);
  res.json({ ok: true, mensagem: 'Configuração salva.' });
});

/* ------------------------------ validação ------------------------------ */

router.post('/validar', sessao.exigirSessao, async (req, res) => {
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
  if (p.destino) {
    const e1 = v.validarCaminho(p.destino, { rotulo: 'Destino' });
    if (e1) resultados.erros.push(e1);
    else {
      const e2 = await v.verificarDiretorioGravavel(p.destino);
      if (e2) resultados.erros.push(e2);
      else resultados.diretorios.push(p.destino);
    }
  }
  if (p.copiaAdicional) {
    const e1 = v.validarCaminho(p.copiaAdicional, { rotulo: 'Cópia adicional' });
    if (e1) resultados.erros.push(e1);
    else {
      const e2 = await v.verificarDiretorioGravavel(p.copiaAdicional);
      if (e2) resultados.erros.push(e2);
      else resultados.diretorios.push(p.copiaAdicional);
    }
  }

  res.json({ ok: resultados.erros.length === 0, ...resultados });
});

/* ------------------------------- decisão ------------------------------- */

router.post('/decisao', sessao.exigirSessao, async (req, res) => {
  const { escolhaManutencao, demoDataSimulada, demoAtivo } = req.body || {};
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
  const decisao = manutencao.decidir({
    chaveConexao: chave,
    escolhaExplicita: escolhaManutencao || 'AUTOMATICA',
    dataSimulada: demo && dataSim ? new Date(dataSim) : null,
    demoAtivo: demo,
    fonteB,
  });
  res.json({ ...decisao, bloqueante: ETAPAS_BLOQUEANTES.has(decisao.tipo) });
});

/* ------------------------------ execuções ------------------------------ */

router.post('/execucoes', sessao.exigirSessao, async (req, res) => {
  const p = req.body || {};
  const s = req.sessao;

  // Concorrência: apenas uma execução por conexão/banco por vez.
  const chave = chaveConexaoDe(s);
  for (const [id, ex] of execucoesAtivas) {
    if (ex.sessao === s && ex.params.banco === p.banco && ex.execucaoId === id) {
      return erro(res, 409, 'Já há uma execução em andamento para este banco. Aguarde a conclusão.');
    }
  }

  // Validações básicas.
  const errs = [v.validarBanco(p.banco)].filter(Boolean);
  if (p.destino) {
    const e = v.validarCaminho(p.destino, { rotulo: 'Destino' });
    if (e) errs.push(e);
  }
  if (errs.length) return erro(res, 400, errs.join(' '));

  // Decisão de manutenção.
  const cfg = db.getConfiguracao(chave) || {};
  let fonteB = null;
  const demo = p.demoAtivo ?? !!cfg.demo_ativo;
  const dataSim = p.demoDataSimulada ?? cfg.demo_data_manutencao ?? null;
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
});

router.get('/execucoes', sessao.exigirSessao, (req, res) => {
  const { status, dias, banco } = req.query;
  const chave = chaveConexaoDe(req.sessao);
  const rows = db.listarExecucoes({ status, dias: dias ? Number(dias) : undefined, chave });
  res.json({ execucoes: rows });
});

router.get('/execucoes/:id', sessao.exigirSessao, (req, res) => {
  const ex = db.buscarExecucao(Number(req.params.id));
  if (!ex) return erro(res, 404, 'Execução não encontrada.');
  res.json({ execucao: ex, logs: db.logsDaExecucao(ex.id) });
});

/* --------------------------------- SSE --------------------------------- */

router.get('/execucoes/:id/eventos', sessao.exigirSessao, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.buscarExecucao(id);
  if (!ex) return erro(res, 404, 'Execução não encontrada.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  // Reenvia o estado atual ao (re)conectar.
  const estado = {
    id: ex.id,
    status: ex.status,
    etapa_falha: ex.etapa_falha,
    resultado: ex.resultado,
    arquivo_final: ex.arquivo_final,
  };
  res.write(`event: estado\ndata: ${JSON.stringify(estado)}\n\n`);

  const executor = execucoesAtivas.get(id);
  if (!executor || ex.status !== 'andamento') {
    // Execução já terminou: envia fim e encerra.
    res.write(`event: fim\ndata: ${JSON.stringify({ status: ex.status })}\n\n`);
    return res.end();
  }

  const aoEvento = (etapa) => res.write(`event: etapa\ndata: ${JSON.stringify(etapa)}\n\n`);
  const aoLog = (log) => res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
  const limparListeners = () => {
    executor.off('etapa', aoEvento);
    executor.off('log', aoLog);
    executor.off('fim', aoFim);
    res.off('close', limparListeners);
    res.off('finish', limparListeners);
  };
  const aoFim = (fim) => {
    res.write(`event: fim\ndata: ${JSON.stringify(fim)}\n\n`);
    res.end();
    limparListeners();
  };

  executor.on('etapa', aoEvento);
  executor.on('log', aoLog);
  executor.on('fim', aoFim);

  res.once('close', limparListeners);
  res.once('finish', limparListeners);
});

/* ----------------------------- restauração ----------------------------- */

router.post('/execucoes/:id/restaurar', sessao.exigirSessao, async (req, res) => {
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
  aguardarPronto.finally(() => restauracoesAtivas.delete(id));

  res.status(202).json({ mensagem: 'Restauração iniciada. Acompanhe o progresso via SSE.' });
});

router.get('/execucoes/:id/restaurar/eventos', sessao.exigirSessao, (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`retry: 3000\n\n`);

  const r = restauracoesAtivas.get(id);
  if (!r) {
    res.write(`event: fim\ndata: ${JSON.stringify({ status: 'nao_encontrado' })}\n\n`);
    return res.end();
  }
  const aoEtapa = e => res.write(`event: etapa\ndata: ${JSON.stringify(e)}\n\n`);
  const aoLog = l => res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
  const aoIntegridade = i => res.write(`event: integridade\ndata: ${JSON.stringify(i)}\n\n`);
  const aoFim = f => {
    res.write(`event: fim\ndata: ${JSON.stringify(f)}\n\n`);
    res.end();
  };
  r.on('etapa', aoEtapa);
  r.on('log', aoLog);
  r.on('integridade', aoIntegridade);
  r.on('fim', aoFim);
  req.on('close', () => {
    r.off('etapa', aoEtapa);
    r.off('log', aoLog);
    r.off('integridade', aoIntegridade);
    r.off('fim', aoFim);
  });
});

/* -------------------------------- logs --------------------------------- */

router.get('/logs', sessao.exigirSessao, (req, res) => {
  const { execucao_id, nivel } = req.query;
  const logs = db.listarLogs({
    execucao_id: execucao_id ? Number(execucao_id) : undefined,
    nivel,
  });
  res.json({ logs });
});

/* ---------------------------- modo demonstração ------------------------- */

router.get('/demo', sessao.exigirSessao, (req, res) => {
  const cfg = db.getConfiguracao(chaveConexaoDe(req.sessao)) || {};
  res.json({
    ativo: !!cfg.demo_ativo,
    dataManutencao: cfg.demo_data_manutencao || null,
  });
});

router.put('/demo', sessao.exigirSessao, (req, res) => {
  const { ativo, dataManutencao } = req.body || {};
  const chave = chaveConexaoDe(req.sessao);
  const cfg = db.getConfiguracao(chave) || {};
  db.salvarConfiguracao({
    chave_conexao: chave,
    demo_ativo: ativo ? 1 : 0,
    demo_data_manutencao: dataManutencao || null,
    // Preserva demais campos.
    destino: cfg.destino, quantidade_manter: cfg.quantidade_manter,
    copia_adicional: cfg.copia_adicional, compactar: cfg.compactar,
    criptografar: cfg.criptografar, pasta_bin: cfg.pasta_bin,
    email_alerta: cfg.email_alerta, smtp_host: cfg.smtp_host,
    smtp_porta: cfg.smtp_porta, smtp_usuario: cfg.smtp_usuario,
  });
  res.json({ ok: true, ativo: !!ativo, dataManutencao: dataManutencao || null });
});

module.exports = router;
