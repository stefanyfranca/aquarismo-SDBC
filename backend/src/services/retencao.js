/**
 * retencao.js — Retenção de backups no destino principal.
 *
 * Considera SOMENTE arquivos do padrão backup-<banco>-* no destino,
 * mantém os N mais recentes (por mtime) — incluindo o recém-criado —
 * e exclui os demais, logando cada remoção. Nunca apaga arquivos fora
 * desse padrão.
 */
const fs = require('fs');
const path = require('path');

/**
 * Aplica a retenção.
 * @returns {{mantidos: string[], removidos: string[]}}
 */
function aplicarRetencao(destino, banco, quantidadeManter) {
  const prefixo = `backup-${banco}-`;
  const entradas = fs.readdirSync(destino, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.startsWith(prefixo))
    .map(e => {
      const full = path.join(destino, e.name);
      const st = fs.statSync(full);
      return { nome: e.name, full, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // mais recentes primeiro

  const mantidos = entradas.slice(0, quantidadeManter).map(e => e.nome);
  const removidos = [];
  for (const e of entradas.slice(quantidadeManter)) {
    try {
      fs.unlinkSync(e.full);
      removidos.push(e.nome);
    } catch (err) {
      // Logado pelo caller via callback de log; aqui apenas propagamos.
      removidos.push(`${e.nome} (FALHA: ${err.message})`);
    }
  }
  return { mantidos, removidos };
}

module.exports = { aplicarRetencao };
