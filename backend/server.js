/**
 * server.js — Ponto de entrada.
 *
 * Porta HTTP: padrão 3000; se ocupada, tenta automaticamente a próxima
 * livre e imprime a URL final no console. Serve apenas em 127.0.0.1.
 */
const app = require('./src/app');
const db = require('./src/db');

// Garante UTF-8 no console (evita acentos corrompidos no Windows).
if (process.stdout && process.stdout.setEncoding) {
  try { process.stdout.setEncoding('utf8'); } catch { /* ok */ }
}

const PORTA_INICIAL = 3000;
const MAX_TENTATIVAS = 20;

function iniciar(porta) {
  const servidor = app.listen(porta, '127.0.0.1', () => {
    console.log('============================================================');
    console.log('  SBAC – Sistema de Backup Aquarismo Charrua');
    console.log(`  Aplicação rodando em: http://127.0.0.1:${porta}`);
    console.log('============================================================');
  });
  servidor.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && porta < PORTA_INICIAL + MAX_TENTATIVAS) {
      console.log(`[servidor] Porta ${porta} ocupada. Tentando ${porta + 1}…`);
      iniciar(porta + 1);
    } else {
      console.error(`[servidor] Falha ao iniciar: ${e.message}`);
      process.exit(1);
    }
  });
}

db.init();
iniciar(PORTA_INICIAL);
