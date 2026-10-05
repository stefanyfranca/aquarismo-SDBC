# SBAC – Sistema de Backup Aquarismo Charrua

Plataforma web de gerenciamento de **backup e manutenção** de bancos PostgreSQL, com interface frontend em HTML/CSS/JS puros, API REST em Node.js/Express e progresso em tempo real via **Server-Sent Events (SSE)**.

## Requisitos

- **Node.js 22+** (usa `node:sqlite` builtin; testado no Node 24)
- **PostgreSQL client tools** (`pg_dump`, `pg_restore`, `psql`) — no Windows, frequentemente em `C:\Program Files\PostgreSQL\<versão>\bin` (a aplicação detecta automaticamente; se não achar, peça o caminho na tela de Configurações)
- **PostgreSQL server** (qualquer versão 12+; testado no PostgreSQL 18)

## Instalação

```bash
npm install
npm start
```

A aplicação sobe em `http://127.0.0.1:3000` (se a porta estiver ocupada, tenta a próxima livre automaticamente e imprime a URL final no console).

## Como usar

1. **Conexão**: informe Host, Porta, Usuário, Senha e Banco. Clique em **Testar conexão** e depois **Conectar**. A senha fica somente em memória e nunca é enviada ao frontend após a conexão.
2. **Dashboard**: visão geral (última manutenção, totais, resumo do banco).
3. **Nova Execução**: configure destino, retenção, cópia adicional, manutenção (Automática/nenhuma/VACUUM/completa), compactação e criptografia. Acompanhe o andamento em tempo real via SSE.
4. **Histórico**: lista execuções com duração, decisão, regra e log. Em sucesso, é possível **Restaurar e conferir integridade**.
5. **Logs**: todos os registros com filtro por execução e nível.
6. **Configurações**: destino padrão, retenção, pasta `bin` do PostgreSQL, e-mail de alerta, SMTP e **modo demonstração**.

## Arquitetura

```
aquarismo-SDBC/
  backend/
    server.js               — entrada (porta 3000 → próxima livre)
    src/
      app.js                — Express, middlewares, segurança, rate limit
      routes/               — definição de rotas por domínio
        index.js            — agregador da API REST + SSE
        conexao.js          — sessão e seleção de banco
        configuracao.js     — configurações por conexão
        execucoes.js        — validação, decisão, execuções, SSE e restauração
        monitor.js          — logs e modo demonstração
      controllers/          — handlers (lógica de request/response)
        conexao.js  configuracao.js  execucoes.js  monitor.js
      services/             — regras de negócio
        pipeline.js         — orquestração das 8 etapas
        manutencao.js       — decisão de manutenção (fontes A/B/simulada)
        criptografia.js     — AES-256-GCM com scrypt (streaming)
        zipaes.js           — descompactação WinZip AES (portátil)
        retencao.js         — retenção de backups
        restauracao.js      — restauração + prova de integridade
        email.js            — envio SMTP ou simulação comprovável
      lib/                  — infraestrutura compartilhada
        conexao.js          — pools, healthcheck, permissões
        pgtools.js          — detecção de pg_dump/pg_restore
        sessao.js           — sessões em memória (cookie HttpOnly)
        db.js               — SQLite local (node:sqlite)
        http.js             — respostas de erro e chave da conexão
        mascara.js          — filtro de segredos em logs
        validacao.js        — validação de nomes, portas, caminhos
    tests/                  — testes automatizados (node:test)
  frontend/                 — HTML/CSS/JS puros, sem build
    index.html
    css/style.css
    js/
      app.js                — bootstrap e roteamento por hash
      estado.js             — estado global e títulos das telas
      lib/                  — api.js, dom.js, formato.js
      telas/                — conexao, dashboard, execucao, historico,
                              logs, configuracoes, restauracao
  database/                 — schema.sql e seed.sql (banco de demonstração)
  documentos/               — notas do projeto
  data/                     — criada em runtime (metadados, logs, outbox)
```

O backend é dividido em **rotas → controllers → services → lib**: as rotas só
declaram caminhos e exigem sessão, os controllers traduzem request/response,
os services concentram as regras e a lib reúne infraestrutura. O frontend é
servido estaticamente pelo Express a partir de `frontend/` e usa módulos ES
nativos (sem bundler).

## Decisões de projeto

- **Metadados fora do banco-alvo**: a aplicação **não cria nenhuma tabela, schema ou função** no banco PostgreSQL. Todo o histórico, configurações e logs ficam em SQLite local (`data/`), fora do banco-alvo. Isso garante que a aplicação funciona em **qualquer banco**, inclusive um vazio.
- **Segredos em memória**: senha do banco, chave AES e senha do ZIP ficam somente em memória (sessão do servidor) e nunca são gravadas em disco, log, resposta de API ou linha de comando. O `pg_dump` recebe a senha via `PGPASSWORD` no ambiente do processo filho (nunca em argumentos). Toda saída técnica passa por um filtro que mascara os segredos com `***`.
- **Agnóstica ao banco**: nenhuma funcionalidade depende de tabelas específicas. A decisão de manutenção usa fontes que existem em qualquer PostgreSQL (histórico local + `pg_stat_user_tables`).

## Formato dos arquivos

### Criptografia AES-256-GCM (`.enc`)

```
[salt 16 bytes][IV 12 bytes][tag GCM 16 bytes][dados cifrados]
```

- Chave derivada por **scrypt** (N=16384, r=8, p=1) com salt aleatório por arquivo.
- **Streaming** (não lê o dump inteiro em memória) — suporta bancos grandes.
- O arquivo em claro é removido após a criptografia.

### Compactação ZIP (`.zip`)

- ZIP com criptografia **AES-256** (WinZip AES), gerado por `archiver-zip-encrypted`.
- A descompactação é feita por módulo próprio (`backend/src/services/zipaes.js`), portável e sem dependências externas.

## Decisão de manutenção

| Situação | Ação |
|---|---|
| Última manutenção há menos de 30 dias | Não executar |
| Entre 30 e 60 dias | `VACUUM` |
| Mais de 60 dias | `VACUUM FULL ANALYZE` |
| Sem histórico | `VACUUM FULL ANALYZE` |

- **Fonte A**: histórico local da plataforma (`manutencoes`).
- **Fonte B**: `SELECT GREATEST(max(last_vacuum), max(last_analyze)) FROM pg_stat_user_tables` (ignora autovacuum).
- Usa a **mais recente** entre A e B. A escolha explícita do usuário **prevalece** sobre a decisão automática.
- **Modo demonstração**: data simulada substitui as fontes A/B (atalhos: 12, 43, 75 dias, sem histórico).

## API (resumo)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/conexao/testar` | Testa credenciais |
| POST | `/api/conexao` | Conecta (cria sessão) |
| DELETE | `/api/conexao` | Desconecta |
| GET | `/api/conexao/estado` | Healthcheck real (`SELECT 1`) |
| GET | `/api/bancos` | Lista bancos disponíveis |
| POST | `/api/bancos/selecionar` | Troca o banco da sessão |
| GET/PUT | `/api/configuracao` | Configurações por conexão |
| POST | `/api/validar` | Testa conexão, permissões e diretórios |
| POST | `/api/decisao` | Prévia da decisão de manutenção |
| POST | `/api/execucoes` | Inicia execução (202 + id; 409 se bloqueante) |
| GET | `/api/execucoes` | Histórico com filtros |
| GET | `/api/execucoes/:id` | Detalhe + log |
| GET | `/api/execucoes/:id/eventos` | SSE (progresso em tempo real) |
| POST | `/api/execucoes/:id/restaurar` | Restaura e confere integridade |
| GET | `/api/logs` | Logs com filtros |
| GET/PUT | `/api/demo` | Modo demonstração |

## Testes automatizados

```bash
npm test
```

Cobrem: regra de decisão (11, 29/30, 60/61 dias, sem data, escolha explícita), validação de caminhos/nomes (injeção, `..`), retenção, criptografia ida-e-volta, mascaramento de segredos e varredura de segredos no código. Teste de integração com PostgreSQL local incluído (pula se não houver servidor).

## Matriz de testes (cenários de aceite)

| # | Cenário | Como executar | Status |
|---|---|---|---|
| 1 | Automática sem manutenção (< 30 dias) | Modo demo → 12 dias → executar | ✅ Verificado |
| 2 | Automática com VACUUM (30–60 dias) | Modo demo → 43 dias → executar | ✅ Verificado |
| 3 | Automática com VACUUM FULL ANALYZE (> 60 dias) | Modo demo → 75 dias → confirmar diálogo | ✅ Verificado |
| 4 | VACUUM FULL ANALYZE sem histórico | Modo demo → sem histórico → executar | ✅ Verificado |
| 5 | Escolha manual prevalecendo | Escolher VACUUM mesmo com > 60 dias | ✅ Verificado |
| 6 | Backup simples com sucesso | Executar sem opções | ✅ Verificado |
| 7 | Backup com criptografia + compactação | Ligar ambas as opções | ✅ Verificado |
| 8 | Retenção (manter 2, rodar 4 vezes) | Quantidade=2, executar 4× | ✅ Verificado |
| 9 | Cópia adicional verificada | Informar cópia adicional | ✅ Verificado (hash SHA-256) |
| 10 | Falha controlada com log + e-mail | Modo demo → simular falha | ✅ Verificado |
| 11 | Restauração + integridade | Histórico → Detalhes → Restaurar | ✅ Verificado |
| 12 | Funciona em banco vazio e no demo | Testado em `sbac_vazio` e `sbac_demo` | ✅ Verificado |
| 13 | Nenhum segredo em logs/código/repositório | `npm test` (varredura automatizada) | ✅ Verificado |
| 14 | Nunca cria objetos no banco-alvo | Comparar `pg_catalog` antes/depois | ✅ Verificado |

## Solução de problemas

- **Porta ocupada**: a aplicação tenta automaticamente a próxima porta livre (3001, 3002, …) e imprime a URL final.
- **Autenticação falha**: verifique usuário/senha. A mensagem é clara em português (senha incorreta, host inacessível, banco inexistente).
- **`pg_dump` não encontrado**: no Windows, informe a pasta `bin` do PostgreSQL em **Configurações → Pasta bin do PostgreSQL**.
- **Incompatibilidade de versão**: se `pg_dump` for mais antigo que o servidor, a aplicação avisa e pede atualização das ferramentas.
- **E-mail não enviado**: sem SMTP configurado, o e-mail é **simulado** e gravado em `data/outbox/email-execucao-N.json/.eml`.

## Limitações

- A restauração de ZIPs com AES-256 usa o módulo próprio (`backend/src/services/zipaes.js`); para ZIPs sem criptografia, também funciona.
- O modo demonstração é por conexão e fica salvo localmente.
- A aplicação serve apenas em `127.0.0.1` por padrão.
