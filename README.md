# Aquarismo SDBC

Sistema de gerenciamento de loja de aquarismo com controle de backup do banco de dados.

Este documento explica **como o projeto funciona**, **o que é necessário para rodar**, **como conectar ao PostgreSQL passo a passo** e **como o projeto está estruturado**.

---

## 1. Visão geral

O projeto está dividido em três partes:

| Pasta        | Descrição                                                                 |
| ------------ | ------------------------------------------------------------------------- |
| `database/`  | Scripts SQL do banco: `schema.sql` (estrutura) e `povoar-banco.sql` (carga) |
| `backend/`   | API em **Node.js + Express** que se conecta ao PostgreSQL via `pg`        |
| `frontend/`  | Aplicação web (SPA) em JavaScript puro, servida pelo Express            |
| `documentos/`| Planejamento e modelagem do projeto                                       |

O backend expõe um endpoint de saúde (`GET /api/health`) que testa a conexão com o banco em tempo real — consumido pelo frontend no indicador "Sistema operacional" do cabeçalho. O frontend (SPA) também aciona execuções de backup via `POST /api/execucoes` e acompanha o progresso em tempo real por SSE (`/api/execucoes/:id/eventos`). Veja as seções 7, 10, 11 e 12.

---

## 2. Tecnologias

- **Node.js** >= 20 (testado com v22)
- **Express** 4 — servidor HTTP
- **pg** 8 — driver/cliente do PostgreSQL
- **dotenv** — carrega credenciais do arquivo `.env`
- **PostgreSQL** >= 15 (local: v18)
- **Frontend** — SPA em JavaScript puro (sem framework), consumindo a API via `fetch` e SSE (`EventSource`)
- ZIP WinZip AES implementado no backend, sem dependência do 7-Zip

---

## 3. Pré-requisitos

1. **[PostgreSQL](https://www.postgresql.org/download/)** instalado e o serviço rodando.
2. **[Node.js](https://nodejs.org/)** (>= 20) e **npm** instalados.
3. Acesso ao cliente `psql` (ou use o pgAdmin/outra ferramenta GUI).

> **Dica (Windows):** se o `psql` não estiver no PATH, ele costuma ficar em
> `C:\Program Files\PostgreSQL\<versão>\bin\`. Você pode executá-lo informando o caminho completo:
> `& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres`

---

## 4. Passo a passo — rodando o projeto

Execute os comandos a partir da **raiz do repositório** (`aquarismo-SDBC/`).

### 4.1 Instalar as dependências do backend

```bash
cd backend
npm install
```

### 4.2 Criar o banco de dados

Crie o banco no PostgreSQL. Exemplo com o usuário `postgres` e banco `aquarismo_sdbc`:

```bash
psql -U postgres -h localhost -c "CREATE DATABASE aquarismo_sdbc;"
```

> Se o banco já existir ou você já o criou pela interface, pule esta etapa.

### 4.3 Aplicar o schema (tabelas)

```bash
psql -U postgres -h localhost -d aquarismo_sdbc -f database/schema.sql
```

### 4.4 Popular o banco com dados de exemplo (opcional)

```bash
psql -U postgres -h localhost -d aquarismo_sdbc -f database/povoar-banco.sql
```

> O `povoar-banco.sql` apaga tudo que existir (`TRUNCATE ... RESTART IDENTITY CASCADE`)
> e insere dados fictícios. Só rode **depois** do schema, senão falha por falta de tabelas.

### 4.5 Configurar as credenciais no `.env`

Copie o modelo e preencha com os seus valores:

```bash
cd backend
copy .env.example .env        # Windows (cmd)
# ou
cp .env.example .env          # Linux/macOS
```

Depois edite o `backend/.env` com seus dados reais (host, porta, banco, usuário e senha):

```
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=aquarismo_sdbc
DB_USER=postgres
DB_PASSWORD=sua_senha_aqui
```

> ⚠️ **Segurança:** o `.env` está no `.gitignore` e **nunca** deve ser versionado.
> A senha é lida apenas em tempo de execução e nunca é impressa nos logs.
> O `.env.example` versionado contém apenas placeholders.

### 4.6 Validar a conexão com o banco (isoladamente, sem subir o servidor)

```bash
npm run test:db
```

Saída esperada em caso de sucesso:

```
Testando conexão com o PostgreSQL...
Conexão OK
  Banco ...: aquarismo_sdbc
  Usuário .: postgres
  Versão ..: PostgreSQL 18.x ...
```

Em caso de falha, o comando termina com código de saída **1** e exibe o motivo (sem a senha).

### 4.7 Subir o servidor

```bash
npm run dev      # desenvolvimento (reinicia sozinho ao salvar)
# ou
npm start        # produção
```

O servidor sobe em `http://localhost:3000`.

### 4.8 Testar o endpoint de saúde

Abra no navegador ou use [cURL](https://curl.se/):

```bash
curl http://localhost:3000/api/health
```

Resposta em caso de sucesso:

```json
{
  "status": "ok",
  "servidor": "operacional",
  "banco": {
    "conectado": true,
    "banco": "aquarismo_sdbc",
    "versao": "PostgreSQL 18.x",
    "horario_servidor": "2026-09-24T01:00:00.000Z",
    "tempo_resposta_ms": 3
  },
  "timestamp": "2026-09-24T01:00:00.000Z"
}
```

Se o banco estiver fora do ar, responde **HTTP 503** com `"banco": { "conectado": false }` e uma mensagem genérica (sem detalhes sensíveis).

---

## 5. Scripts npm (`backend/package.json`)

| Comando             | O que faz                                              |
| ------------------- | ------------------------------------------------------ |
| `npm install`       | Instala as dependências (`express`, `pg`, `dotenv`)   |
| `npm run dev`       | Sobe o servidor com auto-reinício (watch)              |
| `npm start`         | Sobe o servidor normalmente                            |
| `npm run test:db`   | Testa a conexão com o PostgreSQL isoladamente          |

---

## 6. Como o banco está projetado (`database/schema.sql`)

### Tabelas de negócio (loja)

| Tabela                   | Finalidade                                        |
| ------------------------ | ------------------------------------------------- |
| `clientes`               | Clientes da loja                                 |
| `especies`               | Espécies de peixes, plantas e invertebrados      |
| `lotes`                  | Lotes recebidos de cada espécie (estoque de peixes) |
| `produtos_acessorios`    | Ração, filtros, decoração e equipamentos         |
| `pedidos`                | Pedidos dos clientes (pendente/pago/enviado/cancelado) |
| `itens_pedido`           | Itens de cada pedido (peixe ou acessório)        |
| `movimentacoes_estoque`  | Entrada, venda ou perda de estoque               |

### Tabelas de controle de backup

| Tabela                | Finalidade                                                                  |
| --------------------- | --------------------------------------------------------------------------- |
| `configuracoes_backup`| Configuração de cada backup: banco alvo, caminho de destino, quantidade de cópias a manter, criptografia e compactação |
| `execucoes`           | Cada execução de backup: início/fim, decisão de manutenção (`VACUUM` etc.), regra aplicada e status (`em_andamento`, `sucesso`, `falha`) |
| `logs_execucao`       | Etapas detalhadas de cada execução (`etapa`, `mensagem`, `saida_tecnica`)  |

Relação entre elas:

```
configuracoes_backup 1 ──── N execucoes 1 ──── N logs_execucao
```

Pontos relevantes da modelagem:

- `execucoes.config_id` referencia `configuracoes_backup(id)` (uma configuração gera muitas execuções).
- `logs_execucao.execucao_id` referencia `execucoes(id)` com `ON DELETE CASCADE` (apagar a execução apaga seus logs).
- `configuracoes_backup.qtd_manter` define quantas cópias antigas manter.
- `decisao_manutencao` guarda a manutenção sugerida: `NENHUMA`, `VACUUM`, `VACUUM_ANALYZE` ou `VACUUM_FULL_ANALYZE`.

---

## 7. Como o backend está projetado

```
backend/
├── package.json              # dependências e scripts npm
├── .env.example              # modelo de configuração (placeholders)
├── .env                      # credenciais reais — NÃO versionado (gitignore)
└── src/
    ├── index.js              # entrypoint: app Express, rotas, estáticos do frontend e middleware de erros
    ├── database/
    │   └── pool.js           # pool de conexões PostgreSQL (pg) lendo do .env
    ├── routes/
    │   ├── health.js         # rota GET /api/health
    │   └── execucoes.js      # POST/GET de execuções + SSE de progresso (/eventos)
    ├── services/
    │   ├── backup-execution.service.js  # motor de backup (pg_dump, AES-256, ZIP, retenção, VACUUM)
    │   └── execution-events.js          # pub/sub de eventos usado no streaming SSE
    └── scripts/
        └── test-db.js        # valida a conexão isoladamente (npm run test:db)
```

### Fluxo de uma requisição e de uma execução de backup

```
Navegador (SPA do frontend/)
   │  fetch (JSON) + EventSource (SSE)
   ▼
Express (index.js)
   ├── /api/health                  → health.js → pool.js → PostgreSQL → JSON
   ├── /api/execucoes               → execucoes.js → backup-execution.service (assíncrono)
   │                                    ├── pg_dump → arquivo .dump
   │                                    ├── criptografia AES-256-GCM (opcional)
   │                                    ├── compactação ZIP WinZip AES (opcional)
   │                                    ├── retenção (qtd_manter) e cópia adicional
   │                                    └── grava etapas/status em logs_execucao e execucoes
   ├── /api/execucoes/:id/eventos   → execution-events → eventos SSE ao navegador
   └── /* (estáticos)               → index.html, src/app.js, styles.css
```

### Módulo de conexão (`src/database/pool.js`)

- Cria um **pool de conexões** (`pg.Pool`) com limite `max` e timeout configuráveis.
- Lê as credenciais do `.env` via `dotenv` — nenhum valor hardcoded no código.
- Suporta dois modos de configuração:
  - campos individuais `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`;
  - ou uma única `DATABASE_URL` (ex.: `postgres://usuario:senha@host:5432/banco`), que tem prioridade.
- Exporta `pool` e a função `pingDb()`, que executa uma consulta rápida e mede o tempo de resposta.

### Endpoint de saúde (`GET /api/health`)

Equivalente ao indicador de "Sistema operacional" do protótipo: confere se o banco está acessível e devolve versão, horário do servidor e tempo de resposta. Falhas retornam `503` sem expor detalhes internos.

---

## 8. Variáveis de ambiente

| Variável                    | Obrigatória | Padrão       | Descrição                                  |
| --------------------------- | ----------- | ------------ | ------------------------------------------ |
| `PORT`                      | não         | `3000`       | Porta do servidor HTTP                     |
| `DB_HOST`                   | sim*        | `localhost`  | Host do PostgreSQL                          |
| `DB_PORT`                   | sim*        | `5432`       | Porta do PostgreSQL                         |
| `DB_NAME`                   | sim*        | —            | Nome do banco                               |
| `DB_USER`                   | sim*        | —            | Usuário do banco                            |
| `DB_PASSWORD`               | sim*        | —            | Senha do banco (apenas localmente / no env) |
| `DATABASE_URL`              | não         | —            | URI de conexão única (sobrescreve os campos)|
| `DB_POOL_MAX`               | não         | `10`         | Máximo de conexões simultâneas no pool      |
| `DB_CONNECTION_TIMEOUT_MS`  | não         | `5000`       | Timeout de conexão em milissegundos         |
| `DB_SSL`                    | não         | `false`      | Habilita SSL (servidores remotos)           |
| `BACKUP_ALLOWED_ROOTS`      | sim**       | —            | Caminhos autorizados para gravar backups (separados por `;`) |
| `PG_DUMP_PATH`              | não         | `pg_dump`    | Caminho do executável `pg_dump`            |
| `ZIP_PASSWORD`              | não**       | —            | Senha do ZIP quando `compactacao` estiver ativa |
| `BACKUP_ENCRYPTION_KEY`     | não**       | —            | Chave AES-256 (32 bytes) em base64, usada na criptografia |

\* Quando não for usada a `DATABASE_URL`.
\** Obrigatória apenas se a respectiva funcionalidade for utilizada (execução de backup / compactação / criptografia).

---

## 9. Segurança

- **Nunca** commitar o `.env` — ele está no `.gitignore`.
- A senha é lida do ambiente em tempo de execução; não aparece no código nem nos logs.
- O `.env.example` (versionado) contém apenas placeholders como `sua_senha_aqui`.
- O endpoint `/api/health` não expõe detalhes de erro da conexão ao cliente.

---

## 10. Execuções de backup

`POST /api/execucoes` inicia o trabalho em segundo plano e devolve `202 Accepted`.
O andamento pode ser consultado em `GET /api/execucoes/:id` ou acompanhado por SSE
em `GET /api/execucoes/:id/eventos`.

Exemplo:

```json
{
  "banco": "aquarismo_sdbc",
  "destino": "C:\\backups\\principal",
  "qtd_manter": 7,
  "caminho_copia_adicional": "C:\\backups\\copia",
  "compactacao": false,
  "criptografia": false,
  "manutencao_explicita": "vacuum"
}
```

`destino` e `caminho_copia_adicional` devem ser caminhos absolutos dentro de
`BACKUP_ALLOWED_ROOTS`. Para executar backup real, configure `PG_DUMP_PATH` e
`PG_RESTORE_PATH`. ZIP AES protegido requer `ZIP_PASSWORD`. A opção de
criptografia requer `BACKUP_ENCRYPTION_KEY`, uma chave
AES-256 de 32 bytes codificada em base64.

Em bancos existentes, execute uma vez `database/migrations/001_execucoes_validacoes.sql`
para adicionar as regras de integridade de configuração e execução.

---

## 11. Como o frontend e o backend estão conectados

O `frontend/` é uma SPA em JavaScript puro (sem framework e sem etapa de build),
servida pelo próprio Express em `app.use(express.static(.../frontend))`. Ao abrir
`http://localhost:3000`, o backend entrega `index.html`, `styles.css` e o módulo
`src/app.js`.

### Arquivos do frontend

| Arquivo        | Responsabilidade                                         |
| -------------- | -------------------------------------------------------- |
| `index.html`   | Página única: contêiner `#app` e carregamento do módulo  |
| `src/app.js`   | SPA: shell com sidebar, rotas por hash e telas           |
| `src/api.js`   | Camada de comunicação real com o backend (`fetch` + SSE) |
| `styles.css`   | Estilos da interface                                     |

### Rotas da SPA (hash)

`#dashboard`, `#nova-execucao`, `#historico`, `#logs` e `#configuracoes`.
A troca de tela é feita pelo evento `hashchange`, sem recarregar a página.

### Como o front consome o backend (`src/api.js`)

| Funcionalidade                   | Chamada                                            |
| -------------------------------- | -------------------------------------------------- |
| Indicador "Sistema operacional"  | `GET /api/health` (no cabeçalho da SPA)            |
| Iniciar backup manual            | `POST /api/execucoes` (`fetch`)                    |
| Consultar status e logs          | `GET /api/execucoes/:id` (`fetch`)                 |
| Progresso em tempo real          | `GET /api/execucoes/:id/eventos` (SSE via `EventSource`) |
| Histórico, logs e configurações  | endpoints ligados ao PostgreSQL                    |

Na tela **Nova Execução**: o usuário preenche o formulário → `POST /api/execucoes`
recebe `202` com o id da execução → a SPA abre um `EventSource` em `/eventos` e
atualiza a barra de progresso conforme os eventos `progresso` (etapa/mensagem) e
`concluida` (status final). Há também um *polling* de fallback a cada 2,5 s caso o
SSE falhe.

O "Sistema operacional" do cabeçalho usa `getHealth()`; com o banco offline, a SPA
mostra o indicador em vermelho como "Sistema indisponível".

O Histórico oferece filtros de status, banco e período. Logs consultam os registros
persistidos no PostgreSQL. Configurações salvam os parâmetros reais. Histórico
também permite restaurar um backup em banco novo e validar as contagens de negócio.

---

## 12. Resumo das últimas alterações

### Backend
- **Motor de execução de backup** (`src/services/backup-execution.service.js`):
  gera `pg_dump` (formato custom), criptografa com AES-256-GCM, compacta em ZIP com
  AES WinZip nativo, aplica retenção (`qtd_manter`), copia opcionalmente para um segundo
  destino e registra tudo em `configuracoes_backup`, `execucoes` e `logs_execucao`.
- **Manutenção automática**: decide `NENHUMA` (< 30 dias), `VACUUM` (30–60 dias) ou
  `VACUUM_FULL_ANALYZE` (> 60 dias) com base no histórico — ou aceita
  `manutencao_explicita` no corpo da requisição.
- **Segurança no motor**: `BACKUP_ALLOWED_ROOTS` restringe caminhos de destino;
  banco validado como identificador PostgreSQL; saída técnica redigida
  (senhas/chaves/URIs mascaradas) nos logs; senha enviada ao processo filho apenas
  via `PGPASSWORD`.
- **Novas rotas** (`src/routes/execucoes.js`): `POST /api/execucoes`,
  `GET /api/execucoes/:id` e `GET /api/execucoes/:id/eventos` (SSE), apoiadas pelo
  `src/services/execution-events.js`.
- **`index.js`**: passou a servir o frontend e ganhou middleware de erro com status.

### Frontend
- Nova SPA completa: Dashboard, Nova Execução, Histórico, Logs e Configurações.
- Integração real com execução, Histórico, Logs, Configurações, cenários de teste e
  restauração validada pelo backend/PostgreSQL.

### Banco de dados
- `schema.sql`: novas restrições (`qtd_manter > 0`; `data_fim >= data_inicio`;
  status `sucesso` exige `data_fim` e `resultado`).
- Nova migração `database/migrations/001_execucoes_validacoes.sql` para bancos já
  existentes (mesmas validações).

### Configuração
- Novas variáveis de ambiente do motor de backup (ver seção 8): `BACKUP_ALLOWED_ROOTS`,
  `PG_DUMP_PATH`, `PG_RESTORE_PATH`, `ZIP_PASSWORD`, `BACKUP_ENCRYPTION_KEY`.

## Restauracao e teste de integridade

Apos gerar um backup custom (`.dump`), restaure-o em um banco novo de validacao sem sobrescrever o banco da aplicacao:

```powershell
cd backend
npm run restore -- "C:\caminho\autorizado\backup-aquarismo_sdbc-...dump" aquarismo_sdbc_validacao
```

O nome de destino deve ser novo e diferente de `DB_NAME`. O script cria o banco,
executa `pg_restore --exit-on-error` e compara as quantidades e resumos MD5 das
linhas nas tabelas de negócio.
Aceita `.dump`, `.aes` e `.zip`, inclusive `.dump.aes.zip`. No frontend, abra
Histórico e clique **Restaurar** em uma execução concluída; informe o nome de um
banco novo. O arquivo precisa estar dentro de `BACKUP_ALLOWED_ROOTS`.

Defina `PG_DUMP_PATH`, `PG_RESTORE_PATH`, `BACKUP_ALLOWED_ROOTS` e
`BACKUP_DEFAULT_DESTINATION` em `backend/.env`. O caminho padrão precisa pertencer
a uma raiz autorizada. ZIP e criptografia exigem `ZIP_PASSWORD` e
`BACKUP_ENCRYPTION_KEY`, respectivamente.

## Demonstração ponta a ponta pelo frontend

1. Inicie o backend com `npm start` na pasta `backend` e abra `http://localhost:3000`.
2. Em **Nova Execução**, selecione um cenário, clique **Preparar cenário** e confira
   a data/ausência exibida. Deixe a manutenção automática e clique **Iniciar execução**.
3. Repita para menos de 30 dias (NENHUMA), 30–60 (VACUUM), acima de 60
   (VACUUM FULL ANALYZE) e sem histórico (VACUUM FULL ANALYZE).
4. Para comprovar precedência manual, prepare acima de 60 dias, escolha VACUUM e
   inicie a execução.
5. Habilite **Criptografia** e **Compactação** para obter `.dump.aes.zip` protegido.
6. Em Histórico, confira regra, decisão, datas e arquivo. Em Logs, consulte as etapas.
7. Use **Restaurar** em uma execução concluída, informe um banco novo e confira o
   resultado validado e as contagens íntegras.
   8. Em Configurações, informe retenção e cópia adicional; a retenção é aplicada
   aos dois destinos. Para demonstrar falha
   controlada, marque essa opção em Nova Execução; Falha e Notificação são gravadas
   no PostgreSQL sem iniciar manutenção ou gerar backup.
