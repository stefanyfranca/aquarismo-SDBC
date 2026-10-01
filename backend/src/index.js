const express = require('express');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const healthRoutes = require('./routes/health');
const execucoesRoutes = require('./routes/execucoes');
const configuracoesRoutes = require('./routes/configuracoes');

const app = express();

app.use(express.json());
app.use('/api/health', healthRoutes);
app.use('/api/execucoes', execucoesRoutes);
app.use('/api/configuracoes', configuracoesRoutes);
app.use(express.static(path.resolve(__dirname, '../../frontend')));

app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  if (status >= 500) console.error('Erro na API:', err.message);
  res.status(status).json({
    erro: status >= 500 ? 'Erro interno ao processar a solicitação.' : err.message
  });
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Servidor Aquarismo SDBC rodando em http://localhost:${PORT}`);
});
