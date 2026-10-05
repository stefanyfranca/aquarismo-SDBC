/**
 * telas/configuracoes.js — Configurações por conexão (destino, retenção,
 * camadas de proteção, e-mail e modo demonstração).
 */
import { api } from '../lib/api.js';
import { esc, toast } from '../lib/dom.js';
import { atualizarIndicador } from './conexao.js';

export function initConfiguracoes() {
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

export async function carregarConfiguracoes() {
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