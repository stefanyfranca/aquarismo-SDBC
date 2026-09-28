import { getHealth, useConfig, useExecucoes, useLogs } from './api.js';

const app = document.querySelector('#app');
const stageProgress = { validação: 12, manutencao: 28, backup: 50, criptografia: 66, compactacao: 78, retencao: 88, copia_adicional: 94, finalizacao: 100, falha: 100 };
const labels = { validação: 'Validação', manutencao: 'Manutenção', backup: 'Backup', criptografia: 'Criptografia', compactacao: 'Compactação', retencao: 'Retenção', copia_adicional: 'Cópia', finalizacao: 'Criação', falha: 'Falha' };

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
  shell('nova-execucao', 'Nova Execução', `<section class="page-heading"><p>Inicie um backup manual com os parâmetros desejados.</p></section><div class="two-column"><form class="card form-card" id="execution-form"><h2>Iniciar backup manual</h2>${field('Banco de dados', `<input id="banco" value="${escapeHtml(config.banco)}" required>`)}${field('Destino do backup', `<input id="destino" value="${escapeHtml(config.destino)}" required>`)}${field('Quantidade de backups a manter', `<input id="qtd_manter" type="number" min="1" value="${config.qtd_manter}" required>`)}${field('Caminho para cópia adicional', `<input id="caminho_copia_adicional" value="${escapeHtml(config.caminho_copia_adicional || '')}">`)}${toggle('compactacao', 'Compactação', 'Reduz o espaço ocupado pelo arquivo final', config.compactacao)}${toggle('criptografia', 'Criptografia', 'Protege o arquivo gerado no destino', config.criptografia)}<p class="form-error" id="execution-error" aria-live="polite"></p></form><aside><section class="card summary"><h2>Resumo da configuração</h2><p>Parâmetros que serão usados nesta execução</p><dl id="summary"></dl></section><button class="primary start" id="start-execution" type="button">▷ Iniciar execução</button><section class="card progress hidden" id="progress" aria-live="polite"><strong id="progress-stage">Aguardando início</strong><div class="progress-track"><i id="progress-bar"></i></div><span id="progress-percent">0% de conclusão</span><p id="progress-message"></p></section></aside></div>`);
  const ids = ['banco', 'destino', 'qtd_manter', 'caminho_copia_adicional', 'compactacao', 'criptografia'];
  const values = () => ({ banco: document.querySelector('#banco').value.trim(), destino: document.querySelector('#destino').value.trim(), qtd_manter: Number(document.querySelector('#qtd_manter').value), caminho_copia_adicional: document.querySelector('#caminho_copia_adicional').value.trim(), compactacao: document.querySelector('#compactacao').checked, criptografia: document.querySelector('#criptografia').checked });
  const refresh = () => { const data = values(); document.querySelector('#summary').innerHTML = [['Banco', data.banco || '—'], ['Destino', data.destino || '—'], ['Retenção', `${data.qtd_manter || '—'} backups`], ['Compactação', data.compactacao ? 'Ativada' : 'Desativada'], ['Criptografia', data.criptografia ? 'Ativada' : 'Desativada']].map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join(''); };
  ids.forEach((id) => document.querySelector(`#${id}`).addEventListener('input', refresh)); refresh();
  document.querySelector('#start-execution').onclick = async () => {
    const button = document.querySelector('#start-execution'), error = document.querySelector('#execution-error'); error.textContent = '';
    const data = values(); if (!data.banco || !data.destino || data.qtd_manter < 1) { error.textContent = 'Preencha os campos obrigatórios antes de iniciar.'; return; }
    button.disabled = true; button.textContent = 'Iniciando...';
    try { const execution = await useExecucoes.iniciar(data); showProgress('Validação', 5, 'Execução iniciada.'); document.querySelector('#progress').classList.remove('hidden');
      let finished = false;
      const update = ({ etapa, mensagem }) => showProgress(labels[etapa] || etapa, stageProgress[etapa] || 10, mensagem);
      const done = ({ status, resultado }) => { if (finished) return; finished = true; clearInterval(poll); stopEvents(); showProgress(status === 'sucesso' ? 'Concluído' : 'Falha', 100, resultado); button.disabled = false; button.textContent = '▷ Iniciar execução'; };
      const poll = setInterval(async () => { try { const current = await useExecucoes.obter(execution.id); const last = current.logs?.at(-1); if (last) update(last); if (current.status !== 'em_andamento') done(current); } catch { /* the next interval retries without blocking the screen */ } }, 2500);
      const stopEvents = useExecucoes.acompanhar(execution.id, update, done);
    } catch (err) { error.textContent = err.message; button.disabled = false; button.textContent = '▷ Iniciar execução'; }
  };
}
function showProgress(stage, percent, message) { document.querySelector('#progress-stage').textContent = stage; document.querySelector('#progress-bar').style.width = `${percent}%`; document.querySelector('#progress-percent').textContent = `${percent}% de conclusão`; document.querySelector('#progress-message').textContent = message || ''; }

async function history() {
  const all = await useExecucoes.listar();
  shell('historico', 'Histórico', `<section class="page-heading"><p>Consulte as execuções de backup realizadas.</p></section><section class="card"><h2>Histórico de execuções</h2><div class="filters">${field('Status', '<select id="status"><option value="">Todos os status</option><option value="sucesso">Sucesso</option><option value="em_andamento">Em andamento</option><option value="falha">Falha</option></select>')}${field('Período', '<select id="periodo"><option>Últimos 30 dias</option></select>')}${field('Banco', '<select id="banco-filter"><option value="">Todos os bancos</option><option value="aquarismo_sdbc">aquarismo_sdbc</option></select>')}<button class="primary" id="apply">Aplicar filtros</button></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Início</th><th>Término</th><th>Status</th><th>Decisão de manutenção</th><th>Regra aplicada</th><th>Resultado</th><th>Ação</th></tr></thead><tbody id="history-body"></tbody></table></div></section>`);
  const render = () => { const status = document.querySelector('#status').value, banco = document.querySelector('#banco-filter').value; const rows = all.filter((e) => (!status || e.status === status) && (!banco || e.banco === banco)); document.querySelector('#history-body').innerHTML = rows.map((e) => `<tr><td>#${e.id}</td><td>${formatDate(e.data_inicio)}</td><td>${formatDate(e.data_fim)}</td><td>${badge(e.status)}</td><td>${e.decisao_manutencao || '—'}</td><td>${escapeHtml(e.regra_aplicada || '—')}</td><td>${escapeHtml(e.resultado || '—')}</td><td><button class="link-button" data-id="${e.id}">Detalhes</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">Nenhuma execução encontrada.</td></tr>'; };
  document.querySelector('#apply').onclick = render; render();
}

async function logs() {
  shell('logs', 'Logs técnicos', `<section class="page-heading"><p>Registros operacionais das execuções realizadas pelo SBAC</p></section><section class="card"><div class="filters">${field('Execução', '<select id="log-exec"><option value="">Todas as execuções</option><option value="24">Execução #24</option><option value="22">Execução #22</option><option value="21">Execução #21</option></select>')}${field('Etapa', '<select id="log-stage"><option value="">Todas as etapas</option><option>Validação</option><option>Manutenção</option><option>Backup</option><option>Criptografia</option><option>Compactação</option><option>Retenção</option><option>Cópia</option><option>Criação</option><option>Verificação</option></select>')}<button class="primary" id="filter-logs">Filtrar logs</button></div><div class="table-wrap"><table><thead><tr><th>Execução</th><th>Etapa</th><th>Mensagem</th><th>Data/Hora</th><th>Saída técnica</th></tr></thead><tbody id="logs-body"></tbody></table></div></section>`);
  const render = async () => { const rows = await useLogs.listar({ execucao: document.querySelector('#log-exec').value, etapa: document.querySelector('#log-stage').value }); document.querySelector('#logs-body').innerHTML = rows.map((l) => `<tr><td><a href="#historico">#${l.execucao_id}</a></td><td>${l.etapa}</td><td>${escapeHtml(l.mensagem)}</td><td>${formatDate(l.data)}</td><td><code>${escapeHtml(l.saida_tecnica || '—')}</code></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum log encontrado.</td></tr>'; };
  document.querySelector('#filter-logs').onclick = render; render();
}

async function settings() {
  const config = await useConfig.obter();
  shell('configuracoes', 'Configurações', `<div class="two-column"><form class="card form-card" id="config-form"><h2>Configurações de backup</h2><p class="card-description">Esta configuração define como os novos backups serão executados</p>${field('Banco', `<input id="banco" value="${escapeHtml(config.banco)}">`)}${field('Caminho de destino', `<input id="destino" value="${escapeHtml(config.destino)}">`)}${field('Quantidade de backups', `<input id="qtd_manter" type="number" min="1" value="${config.qtd_manter}">`)}${field('Caminho da cópia adicional', `<input id="copia" value="${escapeHtml(config.caminho_copia_adicional || '')}">`)}${toggle('criptografia', 'Criptografar', '', config.criptografia)}${toggle('compactacao', 'Compactar', '', config.compactacao)}<p id="save-message" class="form-error"></p><button class="primary" type="submit">▣ Salvar</button></form><aside><section class="card active-config"><div class="shield">♢</div><h2>Configuração ativa</h2><p>Os parâmetros salvos serão aplicados à próxima execução manual ou agendada. A política de retenção remove apenas backups que ultrapassarem o limite definido.</p></section></aside></div>`);
  document.querySelector('#config-form').onsubmit = async (event) => { event.preventDefault(); await useConfig.salvar({ banco: document.querySelector('#banco').value.trim(), destino: document.querySelector('#destino').value.trim(), qtd_manter: Number(document.querySelector('#qtd_manter').value), caminho_copia_adicional: document.querySelector('#copia').value.trim(), criptografia: document.querySelector('#criptografia').checked, compactacao: document.querySelector('#compactacao').checked }); const message = document.querySelector('#save-message'); message.className = 'success-message'; message.textContent = 'Configuração salva.'; };
}

function dashboard() { shell('dashboard', 'Dashboard', `<section class="page-heading"><p>Acompanhe o estado do sistema de backup.</p></section>`); }
function route() { ({ 'nova-execucao': newExecution, historico: history, logs, configuracoes: settings, dashboard }[location.hash.slice(1)] || newExecution)(); }
window.addEventListener('hashchange', route); route();
