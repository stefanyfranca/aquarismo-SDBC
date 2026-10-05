/**
 * telas/execucao.js — Nova execução: validação, decisão, início e acompanhamento
 * do progresso em tempo real (SSE).
 */
import { api } from '../lib/api.js';
import { esc, toast } from '../lib/dom.js';
import { estado } from '../estado.js';

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

export function initNovaExecucao() {
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

export async function carregarNovaExecucao() {
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

export function renderizarEtapas(estados = {}) {
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

// Os botões ficam fora do <form>, então a validação nativa (required) não roda
// sozinha: disparamos manualmente para acusar campos obrigatórios em branco.
function formExecucaoValido() {
  return document.getElementById('form-execucao').reportValidity();
}

async function validarPreExecucao() {
  if (!formExecucaoValido()) return;
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
  if (!formExecucaoValido()) return;
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
    decisao = await api('POST', '/api/decisao', { escolhaManutencao: p.escolhaManutencao });
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