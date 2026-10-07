/**
 * telas/restauracao.js — Restauração de um backup e conferência de integridade.
 */
import { api } from '../lib/api.js';
import { esc, toast } from '../lib/dom.js';

let restauracaoExecucao = null;
let integridadeAtual = null;

export function abrirRestauracao(execucao) {
  restauracaoExecucao = execucao;
  integridadeAtual = null;
  document.getElementById('modal-detalhes').style.display = 'none';
  document.getElementById('rs-destino').value = `${execucao.parametros?.banco || 'banco'}_restore`;
  const campos = [];
  // Os nomes dos arquivos finais não carregam as camadas (o ZIP final é
  // "backup-<banco>-<ts>.zip"), então usamos os parâmetros registrados na
  // execução e caímos na extensão só como redundância.
  const params = execucao.parametros || {};
  const arquivo = execucao.arquivo_final || '';
  const compactado = params.compactar ?? /\.zip$/i.test(arquivo);
  const cifrado = params.criptografar ?? /\.enc(\.zip)?$/i.test(arquivo);
  if (compactado) {
    campos.push('<label>Senha do ZIP<input type="password" id="rs-senha-zip"></label>');
  }
  if (cifrado) {
    campos.push('<label>Chave AES<input type="password" id="rs-chave-aes"></label>');
  }
  document.getElementById('rs-campos-senha').innerHTML = campos.join('');
  document.getElementById('rs-progresso').textContent = '';
  document.getElementById('rs-progresso').className = 'msg';
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
    integridadeAtual = JSON.parse(e.data);
    renderizarIntegridade(integridadeAtual);
  });
  es.addEventListener('fim', e => {
    const d = JSON.parse(e.data);
    es.close();
    finalizarRestauracao(prog, d);
  });
}

/**
 * A mensagem final nunca esconde o resultado da conferência: divergência ou
 * alerta (ex.: backup vazio) aparece como aviso, não como "concluído" limpo.
 */
function finalizarRestauracao(prog, d) {
  if (d.status === 'falha') {
    prog.className = 'msg erro';
    prog.textContent = `Falha: ${d.erro || 'Restauração interrompida.'}`;
    return;
  }
  if (d.status !== 'sucesso') {
    prog.className = 'msg info';
    prog.textContent = 'Restauração não está mais em andamento. Feche e abra os detalhes novamente para ver o estado.';
    return;
  }

  const alertas = integridadeAtual?.alertas || d.alertas || [];
  const pendentes = (integridadeAtual?.tabelas || []).filter(t => t.status !== 'identico');
  const partes = [];
  if (alertas.length) partes.push(`${alertas.length} aviso(s)`);
  if (pendentes.length) partes.push(`${pendentes.length} tabela(s) divergente(s)`);

  if (partes.length === 0) {
    prog.className = 'msg ok';
    prog.textContent = 'Restauração concluída! Conferência de integridade sem divergências.';
    toast('Restauração concluída!', 'ok');
    return;
  }
  prog.className = 'msg aviso';
  prog.textContent = `Restauração concluída, mas com ${partes.join(' e ')}. Veja a conferência abaixo antes de considerar o banco restaurado.`;
  toast('Restauração concluída com avisos. Verifique a conferência de integridade.', 'info');
}

const ROTULO_STATUS = {
  identico: '✅ idêntico',
  divergente: '❌ divergente',
  ausente: '❌ ausente no restaurado',
  extra: '⚠️ só no restaurado',
};

function renderizarIntegridade(d) {
  const div = document.getElementById('rs-integridade');
  const alertas = (d.alertas || []).map(a => `<li>${esc(a)}</li>`).join('');
  const blocoAlertas = alertas
    ? `<div class="msg aviso" style="display:block"><strong>Atenção</strong><ul style="margin:6px 0 0 18px">${alertas}</ul></div>`
    : '';
  const linhas = d.tabelas.map(t => `
    <tr>
      <td>${esc(t.tabela)}</td>
      <td>${t.origem}</td>
      <td>${t.restaurado}</td>
      <td class="status-${t.status}">${ROTULO_STATUS[t.status] || esc(t.status)}</td>
    </tr>
  `).join('');
  const tabela = d.tabelas.length ? `
    <table class="tabela-integridade">
      <thead><tr><th>Tabela</th><th>Origem</th><th>Restaurado</th><th>Status</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>` : '<p class="muted">Nenhuma tabela de usuário para comparar.</p>';
  const resumo = d.resumo
    ? `<p class="muted">Tabelas na origem: <strong>${d.resumo.origem}</strong> | no restaurado: <strong>${d.resumo.restaurado}</strong> | divergentes: <strong>${d.resumo.divergentes}</strong></p>`
    : '';
  div.innerHTML = `
    <h4 style="margin:14px 0 6px">Conferência de integridade</h4>
    ${blocoAlertas}
    ${d.somenteContagem ? '<p class="muted">Modo somente contagem (hash não calculado).</p>' : ''}
    ${resumo}
    ${tabela}
    <p style="margin-top:10px"><strong>Veredito:</strong> ${esc(d.veredito || '—')}</p>
    <p class="muted" style="margin-top:6px">Divergências podem ocorrer se o banco de origem mudou depois do backup.</p>
  `;
}
