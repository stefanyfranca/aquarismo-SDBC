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
| `frontend/`  | Reservada para a aplicação web (ainda vazia)                              |
| `documentos/`| Planejamento e modelagem do projeto                                       |

O backend expõe um endpoint de saúde (`GET /api/health`) que testa a conexão com o banco em tempo real — o equivalente ao indicador de "Sistema operacional" do protótipo.

---

## 2. Tecnologias

- **Node.js** >= 20 (testado com v22)
- **Express** 4 — servidor HTTP
- **pg** 8 — driver/cliente do PostgreSQL
- **dotenv** — carrega credenciais do arquivo `.env`
- **PostgreSQL** >= 15 (local: v18)

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
    ├── index.js              # entrypoint: cria o app Express e sobe o servidor
    ├── database/
    │   └── pool.js           # pool de conexões PostgreSQL (pg) lendo do .env
    ├── routes/
    │   └── health.js         # rota GET /api/health
    └── scripts/
        └── test-db.js        # valida a conexão isoladamente (npm run test:db)
```

### Fluxo de uma requisição

```
Requisição → Express (index.js) → Rota health (routes/health.js)
          → pool.js (pg Pool) → PostgreSQL → resposta JSON
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

\* Quando não for usada a `DATABASE_URL`.

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
`BACKUP_ALLOWED_ROOTS`. Para executar backup real, configure `PG_DUMP_PATH`; para
ZIP AES protegido, instale/configure o 7-Zip em `SEVEN_ZIP_PATH` e defina
`ZIP_PASSWORD`. A opção de criptografia requer `BACKUP_ENCRYPTION_KEY`, uma chave
AES-256 de 32 bytes codificada em base64.

Em bancos existentes, execute uma vez `database/migrations/001_execucoes_validacoes.sql`
para adicionar as regras de integridade de configuração e execução.
