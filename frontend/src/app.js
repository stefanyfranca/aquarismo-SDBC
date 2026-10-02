import { getHealth, useConfig, useExecucoes, useLogs } from './api.js';

const app = document.querySelector('#app');
const stageProgress = { validacao: 12, cenario_demonstracao: 18, manutencao: 30, manutencao_executada: 42, backup: 58, criptografia: 68, compactacao: 78, retencao: 88, copia_adicional: 94, finalizacao: 100, falha: 100, notificacao: 100 };
const labels = { validacao: 'Validação', cenario_demonstracao: 'Histórico preparado', manutencao: 'Manutenção', manutencao_executada: 'Manutenção executada', backup: 'Backup', criptografia: 'Criptografia', compactacao: 'Compactação', retencao: 'Retenção', copia_adicional: 'Cópia', finalizacao: 'Finalização', falha: 'Falha', notificacao: 'Notificação simulada' };

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const formatDate = (value) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const badge = (status) => `<span class="badge ${status}">${status.replace('_', ' ')}</span>`;

function shell(page, title, content) {
  const links = [['dashboard', 'Dashboard'], ['nova-execucao', 'Nova Execução'], ['historico', 'Histórico'], ['logs', 'Logs'], ['configuracoes', 'Configurações']];
  app.innerHTML = `<aside class="sidebar"><div><div class="brand">SBAC</div><p class="brand-subtitle">Sistema de backup<br>Aquarismo Charrua</p><nav>${links.map(([key, label]) => `<a href="#${key}" class="${page === key ? 'active' : ''}">${label}</a>`).join('')}</nav></div><small>SBAC • Ambiente acadêmico</small></aside><main><header><div><div class="breadcrumb">${title}</div><h1>${title}</h1></div><div id="health" class="system-status"><span>●</span> Sistema operacional</div></header>${content}</main>`;
  getHealth().then((operational) => { const el = document.querySelector('#health'); if (!operational) { el.classList.add('offline'); el.innerHTML = '<span>●</span> Sistema indisponível'; } });
}

function field(label, input, hint = '') { return `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`; }
function toggle(name, title, help, checked) { return `<div class="toggle-row"><div><strong>${title}</strong><small>${help}</small></div><label class="switch"><input id="${name}" type="checkbox" ${checked ? 'checked' : ''}><span></span></label></div>`; }

async function newExecution() {
  const config = await useConfig.obter();
  const activeScenario = await useExecucoes.cenarioAtivo().catch(() => null);
  shell('nova-execucao', 'Nova Execução', `<section class="page-heading"><p>Prepare um cenário para a demonstração ou inicie um backup manual. A decisão automática será calculada pela regra real do backend com o histórico preparado no PostgreSQL.</p></section><section class="card demo-scenario"><h2>Cenário de teste/demonstração</h2><div class="filters">${field('Histórico a preparar', '<select id="demo-scenario"><option value="menos_30">Menos de 30 dias</option><option value="entre_30_60">Entre 30 e 60 dias</option><option value="acima_60">Acima de 60 dias</option><option value="sem_historico">Ausência de histórico</option></select>')}<button class="primary" id="prepare-scenario" type="button">Preparar cenário</button></div><p id="scenario-status" aria-live="polite"></p><dl id="scenario-details"></dl></section><div class="two-column"><form class="card form-card" id="execution-form"><h2>Iniciar execução manual</h2>${field('Banco de dados', `<input id="banco" value="${escapeHtml(config.banco)}" required>`)}${field('Destino do backup', `<input id="destino" value="${escapeHtml(config.destino)}" required>`)}${field('Quantidade de backups a manter', `<input id="qtd_manter" type="number" min="1" value="${config.qtd_manter}" required>`)}${field('Caminho para cópia adicional', `<input id="caminho_copia_adicional" value="${escapeHtml(config.caminho_copia_adicional || '')}">`)}${field('Manutenção', '<select id="manutencao"><option value="">Decidir automaticamente pelo histórico</option><option value="none">Nenhuma</option><option value="vacuum">VACUUM</option><option value="vacuum_full_analyze">VACUUM FULL ANALYZE</option></select>', 'A escolha manual prevalece sobre a decisão automática nesta execução.')}${toggle('compactacao', 'Compactação', 'Reduz o espaço ocupado pelo arquivo final', config.compactacao)}${toggle('criptografia', 'Criptografia', 'Protege o arquivo gerado no destino', config.criptografia)}<p class="form-error" id="execution-error" aria-live="polite"></p></form><aside><section class="card summary"><h2>Resumo da configuração</h2><p>Parâmetros usados nesta execução</p><dl id="summary"></dl></section><button class="primary start" id="start-execution" type="button">Iniciar execução</button><section class="card progress hidden" id="progress" aria-live="polite"><strong id="progress-stage">Aguardando início</strong><div class="progress-track"><i id="progress-bar"></i></div><span id="progress-percent">0% de conclusão</span><p id="progress-message"></p></section><section class="card execution-result hidden" id="execution-result" aria-live="polite"></section></aside></div>`);
  document.querySelector('#execution-form').insertAdjacentHTML('beforeend', toggle('simular_falha', 'Falha controlada', 'Registra falha e notificação no PostgreSQL, sem iniciar manutenção ou backup', false));
  let prepared = activeScenario;
  const renderScenario = (scenario) => {
    prepared = scenario;
    if (scenario) document.querySelector('#demo-scenario').value = scenario.chave;
    document.querySelector('#scenario-status').textContent = scenario
      ? 'Cenário preparado no PostgreSQL. Será consumido por uma execução.' : 'Nenhum cenário preparado.';
    document.querySelector('#scenario-details').innerHTML = scenario
      ? `<div><dt>Cenário</dt><dd>${escapeHtml(scenario.nome)}</dd></div><div><dt>Última manutenção preparada</dt><dd>${scenario.data_ultima_manutencao ? formatDate(scenario.data_ultima_manutencao) : 'Ausência de histórico'}</dd></div><div><dt>Identificador</dt><dd>${escapeHtml(scenario.id)}</dd></div>` : '';
  };
  renderScenario(activeScenario);
  document.querySelector('#prepare-scenario').onclick = async () => {
    const button = document.querySelector('#prepare-scenario'); button.disabled = true;
    try { renderScenario(await useExecucoes.prepararCenario(document.querySelector('#demo-scenario').value)); refresh(); }
    catch (error) { document.querySelector('#scenario-status').textContent = error.message; }
    finally { button.disabled = false; }
  };
  const ids = ['banco', 'destino', 'qtd_manter', 'caminho_copia_adicional', 'compactacao', 'criptografia', 'manutencao', 'simular_falha'];
  const values = () => ({ banco: document.querySelector('#banco').value.trim(), destino: document.querySelector('#destino').value.trim(), qtd_manter: Number(document.querySelector('#qtd_manter').value), caminho_copia_adicional: document.querySelector('#caminho_copia_adicional').value.trim(), compactacao: document.querySelector('#compactacao').checked, criptografia: document.querySelector('#criptografia').checked, simular_falha: document.querySelector('#simular_falha').checked, manutencao_explicita: document.querySelector('#manutencao').value, cenario_teste_id: prepared?.id });
  const refresh = () => { const d = values(), m = { '': 'Automática pelo histórico', none: 'Nenhuma', vacuum: 'VACUUM', vacuum_full_analyze: 'VACUUM FULL ANALYZE' }; document.querySelector('#summary').innerHTML = [['Banco', d.banco || '-'], ['Destino', d.destino || '-'], ['Retenção', `${d.qtd_manter || '-'} backups`], ['Manutenção', m[d.manutencao_explicita]], ['Cenário', prepared?.nome || 'Histórico real'], ['Compactação', d.compactacao ? 'Ativada' : 'Desativada'], ['Criptografia', d.criptografia ? 'Ativada' : 'Desativada']].map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join(''); };
  ids.forEach((id) => document.querySelector(`#${id}`).addEventListener('input', refresh)); refresh();
  document.querySelector('#start-execution').onclick = async () => {
    const button = document.querySelector('#start-execution'), error = document.querySelector('#execution-error'); error.textContent = '';
    const data = values(); if (!data.banco || !data.destino || data.qtd_manter < 1) { error.textContent = 'Preencha os campos obrigatorios antes de iniciar.'; return; } if (!data.manutencao_explicita) delete data.manutencao_explicita;
    button.disabled = true; button.textContent = 'Iniciando...';
    try { const execution = await useExecucoes.iniciar(data); prepared = null; renderScenario(null); refresh(); showProgress('Validação', 5, 'Execução iniciada.'); document.querySelector('#progress').classList.remove('hidden'); let finished = false;
      const update = ({ etapa, mensagem }) => showProgress(labels[etapa] || etapa, stageProgress[etapa] || 10, mensagem);
      let stopEvents = () => {};
      const poll = setInterval(async () => { try { const current = await useExecucoes.obter(execution.id); const last = current.logs?.at(-1); if (last) update(last); if (current.status !== 'em_andamento') done(current); } catch {} }, 1500);
      const done = async ({ status, resultado }) => { if (finished) return; finished = true; clearInterval(poll); stopEvents(); showProgress(status === 'sucesso' ? 'Concluído' : 'Falha', 100, resultado); button.disabled = false; button.textContent = 'Iniciar execução'; try { renderExecutionResult(await useExecucoes.obter(execution.id)); } catch {} };
      stopEvents = useExecucoes.acompanhar(execution.id, update, done);
    } catch (err) { error.textContent = err.message; button.disabled = false; button.textContent = 'Iniciar execucao'; }
  };
}
function showProgress(stage, percent, message) { document.querySelector('#progress-stage').textContent = stage; document.querySelector('#progress-bar').style.width = `${percent}%`; document.querySelector('#progress-percent').textContent = `${percent}% de conclusão`; document.querySelector('#progress-message').textContent = message || ''; }

function renderExecutionResult(e) {
  const box = document.querySelector('#execution-result');
  const days = e.historico_manutencao_em ? `${e.dias_desde_manutencao} dias desde ${formatDate(e.historico_manutencao_em)}` : 'Ausência de histórico';
  box.innerHTML = `<h2>Resultado da execução #${e.id}</h2><dl><div><dt>Cenário testado</dt><dd>${escapeHtml(e.cenario_demonstracao || 'Execução sem cenário de demonstração')}</dd></div><div><dt>Histórico considerado</dt><dd>${escapeHtml(days)}</dd></div><div><dt>Decisão tomada</dt><dd>${escapeHtml(e.decisao_manutencao || 'Pendente')}</dd></div><div><dt>Regra aplicada</dt><dd>${escapeHtml(e.regra_aplicada || '-')}</dd></div><div><dt>Manutenção executada</dt><dd>${escapeHtml(e.manutencao_executada || 'Pendente')}</dd></div><div><dt>Status do backup</dt><dd>${escapeHtml(e.status)}</dd></div><div><dt>Arquivo e caminho</dt><dd>${escapeHtml(e.caminho_arquivo_backup || '-')}</dd></div><div><dt>Início</dt><dd>${escapeHtml(formatDate(e.data_inicio))}</dd></div><div><dt>Fim</dt><dd>${escapeHtml(formatDate(e.data_fim))}</dd></div><div><dt>Resultado</dt><dd>${escapeHtml(e.resultado || '-')}</dd></div></dl>`;
  box.classList.remove('hidden');
}

async function history() {
  let all = await useExecucoes.listar();
  shell('historico', 'Histórico', `<section class="page-heading"><p>Consulte as execuções de backup realizadas.</p></section><section class="card"><h2>Histórico de execuções</h2><div class="filters">${field('Status', '<select id="status"><option value="">Todos os status</option><option value="sucesso">Sucesso</option><option value="em_andamento">Em andamento</option><option value="falha">Falha</option></select>')}${field('Período', '<select id="periodo"><option>Últimos 30 dias</option></select>')}${field('Banco', '<select id="banco-filter"><option value="">Todos os bancos</option><option value="aquarismo_sdbc">aquarismo_sdbc</option></select>')}<button class="primary" id="apply">Aplicar filtros</button></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Cenário</th><th>Início</th><th>Término</th><th>Status</th><th>Decisão de manutenção</th><th>Histórico considerado</th><th>Manutenção executada</th><th>Arquivo de backup</th><th>Regra aplicada</th><th>Resultado</th><th>Ação</th></tr></thead><tbody id="history-body"></tbody></table></div></section>`);
  document.querySelector('#apply').onclick = async () => { all = await useExecucoes.listar({ status: document.querySelector('#status').value, banco: document.querySelector('#banco-filter').value, dias: document.querySelector('#periodo').value }); render(); };
  const render = () => { const rows = all; document.querySelector('#history-body').innerHTML = rows.map((e) => `<tr><td>#${e.id}</td><td>${escapeHtml(e.cenario_demonstracao || 'Manual')}</td><td>${formatDate(e.data_inicio)}</td><td>${formatDate(e.data_fim)}</td><td>${badge(e.status)}</td><td>${e.decisao_manutencao || '—'}</td><td>${e.historico_manutencao_em ? `${e.dias_desde_manutencao} dias` : 'Sem histórico'}</td><td>${escapeHtml(e.manutencao_executada || '—')}</td><td><code>${escapeHtml(e.caminho_arquivo_backup || '—')}</code></td><td>${escapeHtml(e.regra_aplicada || '—')}</td><td>${escapeHtml(e.resultado || '—')}</td><td><a class="link-button" href="#logs?execucao=${e.id}">Logs</a>${e.status === 'sucesso' ? ` <button class="link-button restore-backup" data-id="${e.id}">Restaurar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">Nenhuma execução encontrada.</td></tr>'; };
  document.querySelector('#periodo').innerHTML = '<option value="30">Últimos 30 dias</option><option value="7">Últimos 7 dias</option><option value="90">Últimos 90 dias</option><option value="365">Último ano</option><option value="">Todo o histórico</option>';
  document.querySelector('#history-body').addEventListener('click', async (event) => { const button = event.target.closest('.restore-backup'); if (!button) return; const target = window.prompt('Nome de um banco NOVO para restaurar e validar (não substitui bancos existentes):'); if (!target) return; button.disabled = true; try { const result = await useExecucoes.restaurar(button.dataset.id, target.trim()); const hashesOk = Object.values(result.resumos_md5_negocio_iguais || {}).every(Boolean); window.alert(`Restauração ${result.status} em ${result.banco_restaurado}. Contagens e conteúdo conferidos: ${hashesOk ? 'OK' : 'divergência'}. Tabelas: ${JSON.stringify(result.contagens_negocio_iguais)}`); } catch (error) { window.alert(`Restauração falhou: ${error.message}`); } finally { button.disabled = false; } });
  render();
}

async function logs() {
  const executions = await useExecucoes.listar();
  const options = executions.map((e) => `<option value="${e.id}">Execucao #${e.id} - ${escapeHtml(e.banco)}</option>`).join('');
  shell('logs', 'Logs técnicos', `<section class="page-heading"><p>Consulte as etapas e evidências registradas no banco para cada execução.</p></section><section class="card"><div class="filters">${field('Execução', `<select id="log-exec"><option value="">Selecione uma execução</option>${options}</select>`)}${field('Etapa', '<select id="log-stage"><option value="">Todas as etapas</option><option value="validacao">Validação</option><option value="cenario_demonstracao">Histórico preparado</option><option value="manutencao">Manutenção</option><option value="manutencao_executada">Manutenção executada</option><option value="backup">Backup</option><option value="criptografia">Criptografia</option><option value="compactacao">Compactação</option><option value="retencao">Retenção</option><option value="copia_adicional">Cópia</option><option value="restauracao">Restauração</option><option value="finalizacao">Finalização</option><option value="falha">Falha</option><option value="notificacao">Notificação</option></select>')}<button class="primary" id="filter-logs">Filtrar logs</button></div><div class="table-wrap"><table><thead><tr><th>Execução</th><th>Etapa</th><th>Mensagem</th><th>Data/Hora</th><th>Saída técnica</th></tr></thead><tbody id="logs-body"></tbody></table></div></section>`);
  const render = async () => { const rows = await useLogs.listar({ execucao: document.querySelector('#log-exec').value, etapa: document.querySelector('#log-stage').value }); document.querySelector('#logs-body').innerHTML = rows.map((l) => `<tr><td>#${l.execucao_id}</td><td>${escapeHtml(l.etapa)}</td><td>${escapeHtml(l.mensagem)}</td><td>${formatDate(l.data)}</td><td><code>${escapeHtml(l.saida_tecnica || '-')}</code></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Selecione uma execucao para consultar os registros.</td></tr>'; };
  document.querySelector('#filter-logs').onclick = render;
  const selected = new URLSearchParams(location.hash.split('?')[1] || '').get('execucao');
  if (selected && executions.some((e) => String(e.id) === selected)) { document.querySelector('#log-exec').value = selected; render(); }
}

async function settings() {
  const config = await useConfig.obter();
  shell('configuracoes', 'Configuracoes', `<div class="two-column"><form class="card form-card" id="config-form"><h2>Configuracoes de backup</h2><p class="card-description">Os parametros salvos serao usados como valores iniciais para novas execucoes.</p>${field('Banco', `<input id="banco" value="${escapeHtml(config.banco)}" readonly>`)}${field('Caminho de destino', `<input id="destino" value="${escapeHtml(config.destino)}" required>`)}${field('Quantidade de backups', `<input id="qtd_manter" type="number" min="1" value="${config.qtd_manter}" required>`)}${field('Caminho da copia adicional', `<input id="copia" value="${escapeHtml(config.caminho_copia_adicional || '')}">`)}${toggle('criptografia', 'Criptografar', '', config.criptografia)}${toggle('compactacao', 'Compactar', '', config.compactacao)}<p id="save-message" class="form-error" aria-live="polite"></p><button class="primary" type="submit">Salvar</button></form><aside><section class="card active-config"><div class="shield">*</div><h2>Configuracao ativa</h2><p>Os destinos precisam estar dentro de BACKUP_ALLOWED_ROOTS no arquivo backend/.env.</p></section></aside></div>`);
  document.querySelector('#config-form').onsubmit = async (event) => {
    event.preventDefault();
    const message = document.querySelector('#save-message');
    const button = document.querySelector('#config-form button[type="submit"]');
    button.disabled = true;
    try {
      await useConfig.salvar({ banco: document.querySelector('#banco').value.trim(), destino: document.querySelector('#destino').value.trim(), qtd_manter: Number(document.querySelector('#qtd_manter').value), caminho_copia_adicional: document.querySelector('#copia').value.trim(), criptografia: document.querySelector('#criptografia').checked, compactacao: document.querySelector('#compactacao').checked });
      message.className = 'success-message'; message.textContent = 'Configuracao salva no banco.';
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  };
}

function dashboard() { shell('dashboard', 'Dashboard', `<section class="page-heading"><p>Acompanhe o estado do sistema de backup.</p></section>`); }
function route() { const page = location.hash.slice(1).split('?')[0]; ({ 'nova-execucao': newExecution, historico: history, logs, configuracoes: settings, dashboard }[page] || newExecution)(); }
window.addEventListener('hashchange', route); route();
