const { EventEmitter } = require("events");

/**
 * Barramento de progresso em memória, compartilhado por toda a aplicação.
 *
 * Como funciona:
 *  - Quem EXECUTA o backup (hoje: o simulador em executionService.js;
 *    no futuro: o serviço real de manutenção/backup do colega) chama
 *    publishProgress(executionId, dados) a cada etapa concluída, e
 *    publishDone(executionId, dados) ao final.
 *  - Quem ACOMPANHA (o controller de SSE que atende o Dashboard) chama
 *    subscribe(executionId, callback) e recebe cada evento em tempo real.
 *
 * Isso desacopla a tela do Dashboard de quem gera o progresso: quando o
 * serviço real de backup for implementado, ele só precisa chamar
 * publishProgress/publishDone nos mesmos pontos do fluxo (validação,
 * manutenção, backup, criptografia, compactação, retenção, cópia) e o
 * Dashboard continua funcionando sem nenhuma alteração.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function channelFor(executionId) {
  return `execution:${executionId}`;
}

function publishProgress(executionId, data) {
  emitter.emit(channelFor(executionId), { type: "progress", data });
}

function publishDone(executionId, data) {
  emitter.emit(channelFor(executionId), { type: "done", data });
}

/**
 * Assina os eventos de uma execução. Retorna uma função de cancelamento.
 */
function subscribe(executionId, onEvent) {
  const channel = channelFor(executionId);
  emitter.on(channel, onEvent);
  return () => emitter.off(channel, onEvent);
}

module.exports = { publishProgress, publishDone, subscribe };
