/**
 * mascara.js — Filtro de segredos.
 *
 * Toda saída técnica (stderr de pg_dump/pg_restore, mensagens de erro,
 * parâmetros) passa por mascarar() antes de ser gravada em log, arquivo
 * ou resposta de API. Qualquer ocorrência dos segredos vira '***'.
 */

/**
 * Mascara todas as ocorrências dos segredos no texto.
 * @param {string} texto
 * @param {string[]} segredos — strings que NUNCA devem aparecer (senha, chave AES, senha ZIP)
 * @returns {string}
 */
function mascarar(texto, segredos) {
  if (texto == null) return '';
  let s = String(texto);
  if (!Array.isArray(segredos) || segredos.length === 0) return s;
  // Ordena por tamanho decrescente para evitar máscara parcial de segredo maior.
  const lista = [...new Set(segredos.filter(x => typeof x === 'string' && x.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const segredo of lista) {
    // Escape de regex para tratar o segredo como texto literal.
    const esc = segredo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'g'), '***');
  }
  return s;
}

/**
 * Cria um "sanitizador" que aplica mascarar com um conjunto fixo de segredos.
 * Usado para envolver streams de stderr dos processos filhos.
 */
function criarSanitizador(segredos) {
  return (texto) => mascarar(texto, segredos);
}

module.exports = { mascarar, criarSanitizador };
