/**
 * app.js — Frontend SBAC (HTML/CSS/JS puros, sem framework).
 *
 * Rotas por hash: #/conexao, #/dashboard, #/nova, #/historico, #/logs, #/configuracoes.
 * Progresso em tempo real via Server-Sent Events (SSE).
 * Todo conteúdo dinâmico é escapado (prevenção de XSS).
 */

/* ------------------------------- Utilidades ---------------------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(metodo, url, corpo) {
  const opts = { method: metodo, headers: {}, credentials: 'same-origin' };
  if (corpo !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(corpo);
  }
  const r = await fetch(url, opts);
  let dados = null;
  try { dados = await r.json(); } catch { /* sem corpo */ }
  if (!r.ok) {
    const e = new Error(dados?.erro || `Erro HTTP ${r.status}`);
    e.status = r.status;
    e.dados = dados;
    throw e;
  }
  return dados;
}

function toast(msg, tipo = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function fmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  return d.toLocaleString('pt-BR');
}

function fmtDuracao(inicio, fim) {
  if (!inicio || !fim) return '—';
  const ms = new Date(fim.replace(' ', 'T')) - new Date(inicio.replace(' ', 'T'));
  if (isNaN(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}min ${s % 60}s`;
}

/* ------------------------------- Estado -------------------------------- */

const estado = {
  conectado: false,
  conexao: null,
  rotaAtual: 'conexao',
  eventSource: null,
  execucaoAtiva: null,
};

const TITULOS = {
  conexao: 'Conexão',
  dashboard: 'Dashboard',
  nova: 'Nova Execução',
  historico: 'Histórico',
  logs: 'Logs',
  configuracoes: 'Configurações',
};

/* -------------------------------- Router ------------------------------- */

function navegar(rota) {
  if (!TITULOS[rota]) rota = 'conexao';
  estado.rotaAtual = rota;
  if (estado.eventSource) { estado.eventSource.close(); estado.eventSource = null; }

  document.querySelectorAll('.tela').forEach(t => t.style.display = 'none');
  document.getElementById(`tela-${rota}`).style.display = 'block';
  document.querySelectorAll('.menu a').forEach(a => {
    a.classList.toggle('ativo', a.dataset.rota === rota);
  });
  document.getElementById('breadcrumb').textContent = `SBAC / ${TITULOS[rota]}`;
  document.getElementById('titulo-pagina').textContent = TITULOS[rota];

  // Bloqueia telas que exigem conexão.
  if (rota !== 'conexao' && !estado.conectado) {
    location.hash = '#/conexao';
    return;
  }

  if (rota === 'dashboard') carregarDashboard();
  if (rota === 'nova') carregarNovaExecucao();
  if (rota === 'historico') carregarHistorico();
  if (rota === 'logs') carregarLogs();
  if (rota === 'configuracoes') carregarConfiguracoes();
}

window.addEventListener('hashchange', () => navegar(location.hash.slice(2) || 'conexao'));

/* --------------------------- Indicador de conexão ---------------------- */

async function atualizarIndicador() {
  const el = document.getElementById('indicador-conexao');
  try {
    const r = await api('GET', '/api/conexao/estado');
    estado.conectado = r.conectado;
    estado.conexao = r;
    if (r.conectado) {
      el.textContent = `● Conectado a ${r.usuario}@${r.host}:${r.porta}/${r.banco}`;
      el.className = 'indicador conectado';
      document.getElementById('btn-desconectar').style.display = '';
    } else {
      el.textContent = '● Desconectado';
      el.className = 'indicador desconectado';
      document.getElementById('btn-desconectar').style.display = 'none';
    }
  } catch {
    estado.conectado = false;
    el.textContent = '● Desconectado';
    el.className = 'indicador desconectado';
    document.getElementById('btn-desconectar').style.display = 'none';
  }
  // Aviso do modo demonstração.
  try {
    const d = await api('GET', '/api/demo');
    document.getElementById('aviso-demo').style.display = d.ativo ? '' : 'none';
  } catch { /* ok */ }
}

/* ------------------------------ Tela: Conexão -------------------------- */

function initConexao() {
  // Lembra últimos hosts/usuários/bancos (sem senha).
  const salvo = JSON.parse(localStorage.getItem('sbac_ultimos') || '{}');
  if (salvo.host) document.getElementById('cx-host').value = salvo.host;
  if (salvo.porta) document.getElementById('cx-porta').value = salvo.porta;
  if (salvo.usuario) document.getElementById('cx-usuario').value = salvo.usuario;
  if (salvo.banco) document.getElementById('cx-banco').value = salvo.banco;

  document.getElementById('btn-testar').addEventListener('click', async () => {
    const msg = document.getElementById('msg-conexao');
    msg.className = 'msg info';
    msg.textContent = 'Testando conexão…';
    msg.style.display = 'block';
    try {
      await api('POST', '/api/conexao/testar', lerFormConexao());
      msg.className = 'msg ok';
      msg.textContent = 'Conexão bem-sucedida!';
    } catch (e) {
      msg.className = 'msg erro';
      msg.textContent = e.message;
    }
  });

  document.getElementById('form-conexao').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msg-conexao');
    msg.className = 'msg info';
    msg.textContent = 'Conectando…';
    msg.style.display = 'block';
    try {
      await api('POST', '/api/conexao', lerFormConexao());
      localStorage.setItem('sbac_ultimos', JSON.stringify({
        host: document.getElementById('cx-host').value,
        porta: document.getElementById('cx-porta').value,
        usuario: document.getElementById('cx-usuario').value,
        banco: document.getElementById('cx-banco').value,
      }));
      msg.className = 'msg ok';
      msg.textContent = 'Conectado!';
      await atualizarIndicador();
      await carregarBancos();
      toast('Conexão estabelecida.', 'ok');
      location.hash = '#/dashboard';
    } catch (e) {
      msg.className = 'msg erro';
      msg.textContent = e.message;
    }
  });

  document.getElementById('btn-desconectar').addEventListener('click', async () => {
    try { await api('DELETE', '/api/conexao'); } catch { /* ok */ }
    estado.conectado = false;
    await atualizarIndicador();
    toast('Desconectado.', 'info');
    location.hash = '#/conexao';
  });
}

function lerFormConexao() {
  return {
    host: document.getElementById('cx-host').value.trim(),
    porta: Number(document.getElementById('cx-porta').value),
    usuario: document.getElementById('cx-usuario').value.trim(),
    senha: document.getElementById('cx-senha').value,
    banco: document.getElementById('cx-banco').value.trim() || undefined,
    ssl: document.getElementById('cx-ssl').checked,
  };
}

async function carregarBancos() {
  try {
    const { bancos } = await api('GET', '/api/bancos');
    const lista = document.getElementById('lista-bancos');
    lista.innerHTML = '';
    for (const b of bancos) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = b;
      btn.addEventListener('click', async () => {
        try {
          await api('POST', '/api/bancos/selecionar', { banco: b });
          await atualizarIndicador();
          toast(`Banco "${b}" selecionado.`, 'ok');
        } catch (e) { toast(e.message, 'erro'); }
      });
      li.appendChild(btn);
      lista.appendChild(li);
    }
    document.getElementById('cartao-bancos').style.display = '';
  } catch (e) {
    toast(e.message, 'erro');
  }
}

/* ----------------------------- Tela: Dashboard ------------------------- */

async function carregarDashboard() {
  try {
    const { execucoes } = await api('GET', '/api/execucoes');
    const sucessos = execucoes.filter(e => e.status === 'sucesso').length;
    const falhas = execucoes.filter(e => e.status === 'falha').length;
    document.getElementById('dash-sucessos').textContent = sucessos;
    document.getElementById('dash-falhas').textContent = falhas;

    const ultima = execucoes[0];
    document.getElementById('dash-ultima-execucao').textContent = ultima
      ? `#${ultima.id} — ${fmtData(ultima.inicio)} (${ultima.status})` : '—';

    // Última manutenção conhecida (fonte local).
    const { execucoes: todas } = await api('GET', '/api/execucoes');
    const comManutencao = todas.find(e => e.manutencao_tipo && e.manutencao_tipo !== 'NENHUMA');
    if (comManutencao) {
      document.getElementById('dash-ultima-manutencao').textContent =
        `${comManutencao.manutencao_tipo} — ${fmtData(comManutencao.inicio)}`;
      document.getElementById('dash-fonte-manutencao').textContent = comManutencao.regra_aplicada || '';
    } else {
      document.getElementById('dash-ultima-manutencao').textContent = 'Sem registro';
      document.getElementById('dash-fonte-manutencao').textContent = '';
    }

    // Resumo do banco.
    try {
      const pool = await api('GET', '/api/conexao/estado');
      if (pool.conectado) {
        document.getElementById('dash-resumo-banco').innerHTML =
          esc(`Banco: <strong>${pool.banco}</strong> — consulte o tamanho e o número de tabelas na API.`);
      }
    } catch { /* ok */ }
  } catch (e) {
    toast(e.message, 'erro');
  }
}

/* --------------------------- Tela: Nova Execução ----------------------- */

const ETAPAS_NOMES = {
  validacao: '1. Validação',
  manutencao: '2. Manutenção',
  backup: '3. Backup (pg_dump)',
  criptografia: '4. Criptografia AES',
  compactacao: '5. Compactação ZIP',
  retencao: '6. Retenção',
  copia: '7. Cópia adicional',
  finalizacao: '8. Finalização',
};

function initNovaExecucao() {
  document.getElementById('ex-compactar').addEventListener('change', e => {
    document.getElementById('campo-senha-zip').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('ex-criptografar').addEventListener('change', e => {
    document.getElementById('campo-chave-aes').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('ex-manutencao').addEventListener('change', () => atualizarResumo());
  document.getElementById('ex-destino').addEventListener('input', atualizarResumo);
  document.getElementById('ex-quantidade').addEventListener('input', atualizarResumo);
  document.getElementById('ex-copia').addEventListener('input', atualizarResumo);
  document.getElementById('ex-compactar').addEventListener('change', atualizarResumo);
  document.getElementById('ex-criptografar').addEventListener('change', atualizarResumo);

  document.getElementById('btn-validar').addEventListener('click', validarPreExecucao);
  document.getElementById('btn-iniciar').addEventListener('click', iniciarExecucao);
}

async function carregarNovaExecucao() {
  try {
    const { bancos } = await api('GET', '/api/bancos');
    const sel = document.getElementById('ex-banco');
    sel.innerHTML = '';
    for (const b of bancos) {
      const op = document.createElement('option');
      op.value = b; op.textContent = b;
      if (estado.conexao?.banco === b) op.selected = true;
      sel.appendChild(op);
    }
    // Preenche com configuração salva.
    const cfg = await api('GET', '/api/configuracao');
    if (cfg.destino) document.getElementById('ex-destino').value = cfg.destino;
    if (cfg.quantidade_manter) document.getElementById('ex-quantidade').value = cfg.quantidade_manter;
    if (cfg.copia_adicional) document.getElementById('ex-copia').value = cfg.copia_adicional;
    document.getElementById('ex-compactar').checked = !!cfg.compactar;
    document.getElementById('ex-criptografar').checked = !!cfg.criptografar;
    document.getElementById('campo-senha-zip').style.display = cfg.compactar ? '' : 'none';
    document.getElementById('campo-chave-aes').style.display = cfg.criptografar ? '' : 'none';

    // Mostra opção de simular falha se modo demo ativo.
    const demo = await api('GET', '/api/demo');
    document.getElementById('linha-simular-falha').style.display = demo.ativo ? '' : 'none';

    atualizarResumo();
    renderizarEtapas();
  } catch (e) {
    toast(e.message, 'erro');
  }
}

function atualizarResumo() {
  const banco = document.getElementById('ex-banco').value;
  const destino = document.getElementById('ex-destino').value || '—';
  const qtd = document.getElementById('ex-quantidade').value || 'não informada';
  const copia = document.getElementById('ex-copia').value || 'não informada';
  const manut = document.getElementById('ex-manutencao').selectedOptions[0]?.textContent || '—';
  const compactar = document.getElementById('ex-compactar').checked ? 'Sim' : 'Não';
  const cripto = document.getElementById('ex-criptografar').checked ? 'Sim' : 'Não';
  document.getElementById('resumo-config').innerHTML = `
    <li><span>Banco</span><span>${esc(banco)}</span></li>
    <li><span>Destino</span><span>${esc(destino)}</span></li>
    <li><span>Retenção</span><span>${esc(String(qtd))}</span></li>
    <li><span>Cópia adicional</span><span>${esc(copia)}</span></li>
    <li><span>Manutenção</span><span>${esc(manut)}</span></li>
    <li><span>Compactação</span><span>${compactar}</span></li>
    <li><span>Criptografia</span><span>${cripto}</span></li>
  `;
}

function renderizarEtapas(estados = {}) {
  const ol = document.getElementById('lista-etapas');
  ol.innerHTML = '';
  for (const [chave, nome] of Object.entries(ETAPAS_NOMES)) {
    const est = estados[chave] || 'pendente';
    const icones = { pendente: '⚪', executando: '🔵', ok: '✅', pulada: '⏭️', falha: '❌' };
    const li = document.createElement('li');
    li.innerHTML = `<span class="etapa-icone">${icones[est] || '⚪'}</span>
      <span class="etapa-nome">${esc(nome)}</span>
      <span class="etapa-${est}">${est}</span>`;
    ol.appendChild(li);
  }
}

async function validarPreExecucao() {
  const msg = document.getElementById('msg-validar');
  msg.className = 'msg info';
  msg.textContent = 'Validando…';
  msg.style.display = 'block';
  try {
    const r = await api('POST', '/api/validar', lerFormExecucao());
    if (r.ok) {
      msg.className = 'msg ok';
      msg.textContent = 'Tudo válido: conexão, permissões, diretórios e ferramentas OK.';
    } else {
      msg.className = 'msg erro';
      msg.textContent = 'Problemas: ' + r.erros.join(' | ');
    }
  } catch (e) {
    msg.className = 'msg erro';
    msg.textContent = e.message;
  }
}

function lerFormExecucao() {
  return {
    banco: document.getElementById('ex-banco').value,
    destino: document.getElementById('ex-destino').value.trim(),
    quantidadeManter: Number(document.getElementById('ex-quantidade').value) || null,
    copiaAdicional: document.getElementById('ex-copia').value.trim() || null,
    compactar: document.getElementById('ex-compactar').checked,
    criptografar: document.getElementById('ex-criptografar').checked,
    escolhaManutencao: document.getElementById('ex-manutencao').value,
    simularFalha: document.getElementById('ex-simular-falha').checked,
  };
}

async function iniciarExecucao() {
  const p = lerFormExecucao();

  // Valida senhas.
  if (p.compactar) {
    const s1 = document.getElementById('ex-senha-zip').value;
    const s2 = document.getElementById('ex-senha-zip2').value;
    if (s1.length < 8) return toast('Senha do ZIP deve ter ao menos 8 caracteres.', 'erro');
    if (s1 !== s2) return toast('As senhas do ZIP não coincidem.', 'erro');
    p.senhaZip = s1;
  }
  if (p.criptografar) {
    const s1 = document.getElementById('ex-chave-aes').value;
    const s2 = document.getElementById('ex-chave-aes2').value;
    if (s1.length < 8) return toast('Chave AES deve ter ao menos 8 caracteres.', 'erro');
    if (s1 !== s2) return toast('As chaves AES não coincidem.', 'erro');
    p.chaveAes = s1;
  }

  // Prévia da decisão (para diálogo de confirmação do VACUUM FULL).
  let decisao = null;
  try {
    const d = await api('POST', '/api/decisao', { escolhaManutencao: p.escolhaManutencao });
    decisao = d;
  } catch (e) { return toast(e.message, 'erro'); }

  const confirmar = async () => {
    document.getElementById('modal-confirmacao').style.display = 'none';
    await executar(p, true);
  };

  if (decisao.bloqueante) {
    document.getElementById('modal-texto').textContent =
      `A manutenção decidida é VACUUM FULL ANALYZE, que BLOQUEIA as tabelas durante a execução. ` +
      `Deseja continuar? Regra: ${decisao.regra}`;
    document.getElementById('modal-confirmacao').style.display = 'flex';
    document.getElementById('modal-confirmar').onclick = confirmar;
    document.getElementById('modal-cancelar').onclick = () => {
      document.getElementById('modal-confirmacao').style.display = 'none';
    };
    return;
  }
  await executar(p, false);
}

async function executar(p, confirmado) {
  const msg = document.getElementById('resultado-execucao');
  msg.className = 'msg info';
  msg.textContent = 'Iniciando execução…';
  msg.style.display = 'block';
  renderizarEtapas();
  try {
    const r = await api('POST', '/api/execucoes', { ...p, confirmar: confirmado });
    estado.execucaoAtiva = r.id;
    msg.className = 'msg ok';
    msg.textContent = `Execução #${r.id} iniciada. Acompanhe o andamento abaixo.`;
    acompanharExecucao(r.id);
  } catch (e) {
    if (e.status === 409 && e.dados?.requerConfirmacao) {
      document.getElementById('modal-texto').textContent =
        `A manutenção decidida é VACUUM FULL ANALYZE, que BLOQUEIA as tabelas. Deseja continuar? Regra: ${e.dados.decisao.regra}`;
      document.getElementById('modal-confirmacao').style.display = 'flex';
      document.getElementById('modal-confirmar').onclick = async () => {
        document.getElementById('modal-confirmacao').style.display = 'none';
        await executar(p, true);
      };
      document.getElementById('modal-cancelar').onclick = () => {
        document.getElementById('modal-confirmacao').style.display = 'none';
      };
    } else {
      msg.className = 'msg erro';
      msg.textContent = e.message;
    }
  }
}

function acompanharExecucao(id) {
  if (estado.eventSource) estado.eventSource.close();
  const es = new EventSource(`/api/execucoes/${id}/eventos`);
  estado.eventSource = es;
  const estados = {};

  es.addEventListener('estado', e => {
    const d = JSON.parse(e.data);
    if (d.status === 'andamento') return;
  });
  es.addEventListener('etapa', e => {
    const d = JSON.parse(e.data);
    estados[d.etapa] = d.estado;
    renderizarEtapas(estados);
    if (d.estado === 'falha') {
      toast(`Etapa "${ETAPAS_NOMES[d.etapa]}" falhou: ${d.erro}`, 'erro');
    }
  });
  es.addEventListener('log', e => {
    const d = JSON.parse(e.data);
    if (d.nivel === 'erro') toast(d.mensagem, 'erro');
  });
  es.addEventListener('fim', e => {
    const d = JSON.parse(e.data);
    es.close();
    estado.eventSource = null;
    const msg = document.getElementById('resultado-execucao');
    if (d.status === 'sucesso') {
      msg.className = 'msg ok';
      msg.textContent = `Execução #${id} concluída com sucesso!`;
      toast('Backup concluído com sucesso!', 'ok');
    } else {
      msg.className = 'msg erro';
      msg.textContent = `Execução #${id} falhou.`;
    }
    estado.execucaoAtiva = null;
  });
}

/* ----------------------------- Tela: Histórico ------------------------- */

async function carregarHistorico() {
  try {
    const params = new URLSearchParams();
    const status = document.getElementById('filtro-status').value;
    const periodo = document.getElementById('filtro-periodo').value;
    if (status) params.set('status', status);
    if (periodo) params.set('dias', periodo);
    const { execucoes } = await api('GET', `/api/execucoes?${params}`);
    const tbody = document.querySelector('#tabela-historico tbody');
    tbody.innerHTML = '';
    for (const e of execucoes) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${e.id}</td>
        <td>${fmtData(e.inicio)}</td>
        <td>${fmtData(e.fim)}</td>
        <td>${fmtDuracao(e.inicio, e.fim)}</td>
        <td><span class="etiqueta ${e.status}">${e.status}</span></td>
        <td>${esc(e.manutencao_tipo || '—')}</td>
        <td>${esc(e.regra_aplicada || '—')}</td>
        <td>${esc(e.resultado || '—')}</td>
        <td><button class="btn btn-secundario btn-pequeno" data-id="${e.id}">Detalhes</button></td>
      `;
      tr.querySelector('button').addEventListener('click', () => abrirDetalhes(e.id));
      tbody.appendChild(tr);
    }
    if (execucoes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">Nenhuma execução encontrada.</td></tr>';
    }
  } catch (e) {
    toast(e.message, 'erro');
  }
}

async function abrirDetalhes(id) {
  try {
    const { execucao, logs } = await api('GET', `/api/execucoes/${id}`);
    document.getElementById('modal-detalhes-titulo').textContent = `Execução #${id} — ${execucao.status}`;
    let html = `
      <p><strong>Início:</strong> ${fmtData(execucao.inicio)} | <strong>Fim:</strong> ${fmtData(execucao.fim)} | <strong>Duração:</strong> ${fmtDuracao(execucao.inicio, execucao.fim)}</p>
      <p><strong>Decisão:</strong> ${esc(execucao.manutencao_tipo || '—')}</p>
      <p><strong>Regra:</strong> ${esc(execucao.regra_aplicada || '—')}</p>
      <p><strong>Resultado:</strong> ${esc(execucao.resultado || '—')}</p>
      <p><strong>Arquivo final:</strong> ${esc(execucao.arquivo_final || '—')}</p>
      <h4 style="margin:14px 0 6px">Log completo</h4>
      <div class="lista-logs" style="max-height:300px">
        ${logs.map(l => `<div class="linha-log ${l.nivel}"><span class="log-data">${esc(l.data)}</span> [${esc(l.etapa)}] ${esc(l.mensagem)}</div>`).join('')}
      </div>
    `;
    if (execucao.status === 'sucesso' && execucao.arquivo_final) {
      html += `<div class="linha-botoes"><button class="btn btn-primario" id="btn-restaurar">Restaurar e conferir integridade</button></div>`;
    }
    document.getElementById('modal-detalhes-corpo').innerHTML = html;
    document.getElementById('modal-detalhes').style.display = 'flex';
    document.getElementById('modal-detalhes-fechar').onclick = () => {
      document.getElementById('modal-detalhes').style.display = 'none';
    };
    const btnR = document.getElementById('btn-restaurar');
    if (btnR) btnR.addEventListener('click', () => abrirRestauracao(execucao));
  } catch (e) {
    toast(e.message, 'erro');
  }
}

/* ---------------------------- Tela: Logs ------------------------------- */

async function carregarLogs() {
  try {
    const { execucoes } = await api('GET', '/api/execucoes');
    const sel = document.getElementById('filtro-log-execucao');
    sel.innerHTML = '<option value="">Execução: todas</option>';
    for (const e of execucoes) {
      const op = document.createElement('option');
      op.value = e.id; op.textContent = `#${e.id} — ${e.status} — ${fmtData(e.inicio)}`;
      sel.appendChild(op);
    }
    await carregarListaLogs();
  } catch (e) {
    toast(e.message, 'erro');
  }
}

async function carregarListaLogs() {
  const params = new URLSearchParams();
  const ex = document.getElementById('filtro-log-execucao').value;
  const nivel = document.getElementById('filtro-log-nivel').value;
  if (ex) params.set('execucao_id', ex);
  if (nivel) params.set('nivel', nivel);
  try {
    const { logs } = await api('GET', `/api/logs?${params}`);
    const div = document.getElementById('lista-logs');
    div.innerHTML = logs.map(l =>
      `<div class="linha-log ${l.nivel}"><span class="log-data">${esc(l.data)}</span> [${esc(l.etapa)}] [${esc(l.nivel)}] ${esc(l.mensagem)}</div>`
    ).join('') || '<p class="muted">Nenhum log.</p>';
  } catch (e) {
    toast(e.message, 'erro');
  }
}

/* -------------------------- Tela: Configurações ------------------------ */

function initConfiguracoes() {
  document.getElementById('cf-demo').addEventListener('change', e => {
    document.getElementById('campos-demo').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('form-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msg-config');
    try {
      const demoData = document.getElementById('cf-demo-data').value;
      await api('PUT', '/api/configuracao', {
        destino: document.getElementById('cf-destino').value.trim() || null,
        quantidadeManter: Number(document.getElementById('cf-quantidade').value) || null,
        copiaAdicional: document.getElementById('cf-copia').value.trim() || null,
        criptografar: document.getElementById('cf-criptografar').checked,
        compactar: document.getElementById('cf-compactar').checked,
        pastaBin: document.getElementById('cf-pasta-bin').value.trim() || null,
        emailAlerta: document.getElementById('cf-email').value.trim() || null,
        smtpHost: document.getElementById('cf-smtp-host').value.trim() || null,
        smtpPorta: Number(document.getElementById('cf-smtp-porta').value) || null,
        smtpUsuario: document.getElementById('cf-smtp-usuario').value.trim() || null,
        demoAtivo: document.getElementById('cf-demo').checked,
        demoDataManutencao: demoData ? new Date(Date.now() - Number(demoData) * 86400000).toISOString() : null,
      });
      msg.className = 'msg ok';
      msg.textContent = 'Configurações salvas.';
      msg.style.display = 'block';
      await atualizarIndicador();
    } catch (e2) {
      msg.className = 'msg erro';
      msg.textContent = e2.message;
      msg.style.display = 'block';
    }
  });
}

async function carregarConfiguracoes() {
  try {
    const cfg = await api('GET', '/api/configuracao');
    document.getElementById('cf-destino').value = cfg.destino || '';
    document.getElementById('cf-quantidade').value = cfg.quantidade_manter || '';
    document.getElementById('cf-copia').value = cfg.copia_adicional || '';
    document.getElementById('cf-criptografar').checked = !!cfg.criptografar;
    document.getElementById('cf-compactar').checked = !!cfg.compactar;
    document.getElementById('cf-pasta-bin').value = cfg.pasta_bin || '';
    document.getElementById('cf-email').value = cfg.email_alerta || '';
    document.getElementById('cf-smtp-host').value = cfg.smtp_host || '';
    document.getElementById('cf-smtp-porta').value = cfg.smtp_porta || 587;
    document.getElementById('cf-smtp-usuario').value = cfg.smtp_usuario || '';
    document.getElementById('cf-demo').checked = !!cfg.demo_ativo;
    document.getElementById('campos-demo').style.display = cfg.demo_ativo ? '' : 'none';

    document.getElementById('config-ativa').innerHTML = `
      <li><span>Destino</span><span>${esc(cfg.destino || '—')}</span></li>
      <li><span>Retenção</span><span>${cfg.quantidade_manter || 'não informada'}</span></li>
      <li><span>Cópia adicional</span><span>${esc(cfg.copia_adicional || '—')}</span></li>
      <li><span>Criptografar</span><span>${cfg.criptografar ? 'Sim' : 'Não'}</span></li>
      <li><span>Compactar</span><span>${cfg.compactar ? 'Sim' : 'Não'}</span></li>
      <li><span>Pasta bin</span><span>${esc(cfg.pasta_bin || 'PATH (automático)')}</span></li>
      <li><span>E-mail alerta</span><span>${esc(cfg.email_alerta || '—')}</span></li>
      <li><span>Modo demonstração</span><span>${cfg.demo_ativo ? 'ATIVO' : 'desligado'}</span></li>
    `;
  } catch (e) {
    toast(e.message, 'erro');
  }
}

/* ----------------------------- Restauração ----------------------------- */

let restauracaoExecucao = null;

function abrirRestauracao(execucao) {
  restauracaoExecucao = execucao;
  document.getElementById('modal-detalhes').style.display = 'none';
  document.getElementById('rs-destino').value = `${execucao.parametros?.banco || 'banco'}_restore`;
  const campos = [];
  if (execucao.arquivo_final?.endsWith('.zip')) {
    campos.push('<label>Senha do ZIP<input type="password" id="rs-senha-zip"></label>');
  }
  if (execucao.arquivo_final?.endsWith('.enc') || execucao.arquivo_final?.endsWith('.enc.zip')) {
    campos.push('<label>Chave AES<input type="password" id="rs-chave-aes"></label>');
  }
  document.getElementById('rs-campos-senha').innerHTML = campos.join('');
  document.getElementById('rs-progresso').textContent = '';
  document.getElementById('rs-integridade').innerHTML = '';
  document.getElementById('modal-restaurar').style.display = 'flex';

  document.getElementById('rs-cancelar').onclick = () => {
    document.getElementById('modal-restaurar').style.display = 'none';
  };
  document.getElementById('form-restaurar').onsubmit = async (e) => {
    e.preventDefault();
    await executarRestauracao();
  };
}

async function executarRestauracao() {
  const prog = document.getElementById('rs-progresso');
  prog.className = 'msg info';
  prog.textContent = 'Iniciando restauração…';
  prog.style.display = 'block';
  try {
    await api('POST', `/api/execucoes/${restauracaoExecucao.id}/restaurar`, {
      bancoDestino: document.getElementById('rs-destino').value.trim(),
      senhaZip: document.getElementById('rs-senha-zip')?.value || undefined,
      chaveAes: document.getElementById('rs-chave-aes')?.value || undefined,
      recriarSeExistir: document.getElementById('rs-recriar').checked,
      somenteContagem: document.getElementById('rs-so-contagem').checked,
    });
    acompanharRestauracao(restauracaoExecucao.id);
  } catch (e) {
    prog.className = 'msg erro';
    prog.textContent = e.message;
  }
}

function acompanharRestauracao(id) {
  const es = new EventSource(`/api/execucoes/${id}/restaurar/eventos`);
  const prog = document.getElementById('rs-progresso');
  es.addEventListener('etapa', e => {
    const d = JSON.parse(e.data);
    if (d.estado === 'executando') prog.textContent = `Etapa: ${d.etapa}…`;
    if (d.estado === 'falha') {
      prog.className = 'msg erro';
      prog.textContent = `Falha: ${d.erro}`;
    }
  });
  es.addEventListener('log', e => {
    const d = JSON.parse(e.data);
    if (d.nivel === 'erro') toast(d.mensagem, 'erro');
  });
  es.addEventListener('integridade', e => {
    const d = JSON.parse(e.data);
    renderizarIntegridade(d);
  });
  es.addEventListener('fim', e => {
    const d = JSON.parse(e.data);
    es.close();
    if (d.status === 'sucesso') {
      prog.className = 'msg ok';
      prog.textContent = 'Restauração concluída!';
      toast('Restauração concluída!', 'ok');
    }
  });
}

function renderizarIntegridade(d) {
  const div = document.getElementById('rs-integridade');
  const linhas = d.tabelas.map(t => `
    <tr>
      <td>${esc(t.tabela)}</td>
      <td>${t.origem}</td>
      <td>${t.restaurado}</td>
      <td class="status-${t.status}">${t.status === 'identico' ? '✅ idêntico' : '❌ divergente'}</td>
    </tr>
  `).join('');
  div.innerHTML = `
    <h4 style="margin:14px 0 6px">Conferência de integridade</h4>
    ${d.somenteContagem ? '<p class="muted">Modo somente contagem (hash não calculado).</p>' : ''}
    <table class="tabela-integridade">
      <thead><tr><th>Tabela</th><th>Origem</th><th>Restaurado</th><th>Status</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
    <p style="margin-top:10px"><strong>Veredito:</strong> ${esc(d.veredito)}</p>
    <p class="muted" style="margin-top:6px">Divergências podem ocorrer se o banco de origem mudou depois do backup.</p>
  `;
}

/* -------------------------------- Init --------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  initConexao();
  initNovaExecucao();
  initConfiguracoes();
  document.getElementById('btn-filtrar').addEventListener('click', carregarHistorico);
  document.getElementById('filtro-log-execucao').addEventListener('change', carregarListaLogs);
  document.getElementById('filtro-log-nivel').addEventListener('change', carregarListaLogs);
  atualizarIndicador();
  navegar(location.hash.slice(2) || 'conexao');
});
