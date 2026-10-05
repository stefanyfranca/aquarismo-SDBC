/**
 * telas/conexao.js — Tela de conexão: credenciais, bancos e indicador do topo.
 */
import { api } from '../lib/api.js';
import { toast } from '../lib/dom.js';
import { estado } from '../estado.js';

/** Atualiza o indicador de conexão no cabeçalho e o aviso do modo demonstração. */
export async function atualizarIndicador() {
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

export function initConexao() {
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

export async function carregarBancos() {
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