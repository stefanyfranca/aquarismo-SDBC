/**
 * app.js — Aplicação Express: middlewares, cabeçalhos de segurança,
 * limite de JSON, rate limit simples em /api/conexao*, rotas e arquivos
 * estáticos de frontend/.
 */
const express = require('express');
const path = require('path');
const rotas = require('./routes');

// O frontend fica na raiz do projeto, fora de backend/.
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');

const app = express();

// Cabeçalhos básicos de segurança (equivalente simplificado ao helmet).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  next();
});

// Limite de tamanho de JSON.
app.use(express.json({ limit: '1mb' }));

// Rate limit simples em /api/conexao* (máx. 10 tentativas/min por IP).
const tentativas = new Map();
app.use('/api/conexao', (req, res, next) => {
  const ip = req.ip || 'desconhecido';
  const agora = Date.now();
  const janela = tentativas.get(ip) || [];
  const recentes = janela.filter(t => agora - t < 60000);
  if (recentes.length >= 10) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 1 minuto e tente novamente.' });
  }
  recentes.push(agora);
  tentativas.set(ip, recentes);
  next();
});

// API.
app.use('/api', rotas);

// Arquivos estáticos.
app.use(express.static(FRONTEND_DIR));

// Fallback: index.html para rotas de hash não afetam o servidor, mas garantimos.
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Tratamento de erros global.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[erro]', err.message);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

module.exports = app;
