CREATE TABLE clientes (
    id          SERIAL PRIMARY KEY,
    nome        VARCHAR(150) NOT NULL,
    email       VARCHAR(150) UNIQUE NOT NULL,
    telefone    VARCHAR(30),
    criado_em   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE especies (
    id                  SERIAL PRIMARY KEY,
    nome_popular        VARCHAR(100) NOT NULL,
    nome_cientifico     VARCHAR(150),
    categoria           VARCHAR(20) NOT NULL CHECK (categoria IN ('peixe','planta','invertebrado')),
    nivel_dificuldade   VARCHAR(20) CHECK (nivel_dificuldade IN ('facil','medio','dificil'))
);

CREATE TABLE lotes (
    id                  SERIAL PRIMARY KEY,
    especie_id          INTEGER NOT NULL REFERENCES especies(id),
    fornecedor          VARCHAR(150),
    data_chegada        DATE NOT NULL DEFAULT CURRENT_DATE,
    quantidade_inicial  INTEGER NOT NULL CHECK (quantidade_inicial >= 0),
    quantidade_atual    INTEGER NOT NULL CHECK (quantidade_atual >= 0),
    preco_unitario      NUMERIC(10,2) NOT NULL CHECK (preco_unitario >= 0)
);

CREATE TABLE produtos_acessorios (
    id              SERIAL PRIMARY KEY,
    nome            VARCHAR(150) NOT NULL,
    categoria       VARCHAR(20) NOT NULL CHECK (categoria IN ('racao','filtro','decoracao','equipamento')),
    preco           NUMERIC(10,2) NOT NULL CHECK (preco >= 0),
    estoque_atual   INTEGER NOT NULL DEFAULT 0 CHECK (estoque_atual >= 0)
);

CREATE TABLE pedidos (
    id            SERIAL PRIMARY KEY,
    cliente_id    INTEGER NOT NULL REFERENCES clientes(id),
    data_pedido   TIMESTAMP NOT NULL DEFAULT now(),
    status        VARCHAR(20) NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','enviado','cancelado')),
    total         NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE itens_pedido (
    id              SERIAL PRIMARY KEY,
    pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    tipo_item       VARCHAR(10) NOT NULL CHECK (tipo_item IN ('peixe','acessorio')),
    lote_id         INTEGER REFERENCES lotes(id),
    produto_id      INTEGER REFERENCES produtos_acessorios(id),
    quantidade      INTEGER NOT NULL CHECK (quantidade > 0),
    preco_unitario  NUMERIC(10,2) NOT NULL,
    CONSTRAINT chk_item_referencia CHECK (
        (tipo_item = 'peixe' AND lote_id IS NOT NULL AND produto_id IS NULL) OR
        (tipo_item = 'acessorio' AND produto_id IS NOT NULL AND lote_id IS NULL)
    )
);

CREATE TABLE movimentacoes_estoque (
    id           SERIAL PRIMARY KEY,
    lote_id      INTEGER REFERENCES lotes(id),
    produto_id   INTEGER REFERENCES produtos_acessorios(id),
    tipo         VARCHAR(10) NOT NULL CHECK (tipo IN ('entrada','venda','perda')),
    quantidade   INTEGER NOT NULL CHECK (quantidade > 0),
    data         TIMESTAMP NOT NULL DEFAULT now(),
    observacao   VARCHAR(255),
    CONSTRAINT chk_mov_referencia CHECK (
        (lote_id IS NOT NULL AND produto_id IS NULL) OR
        (lote_id IS NULL AND produto_id IS NOT NULL)
    )
);

CREATE INDEX idx_lotes_especie ON lotes(especie_id);
CREATE INDEX idx_pedidos_cliente ON pedidos(cliente_id);
CREATE INDEX idx_itens_pedido_pedido ON itens_pedido(pedido_id);
CREATE INDEX idx_mov_estoque_data ON movimentacoes_estoque(data);
CREATE INDEX idx_mov_estoque_lote ON movimentacoes_estoque(lote_id);

-- --------------------------------------------------------------------------

CREATE TABLE configuracoes_backup (
    id                SERIAL PRIMARY KEY,
    banco             VARCHAR(100) NOT NULL,
    caminho_destino   VARCHAR(255) NOT NULL,
    qtd_manter        INTEGER NOT NULL DEFAULT 7 CHECK (qtd_manter > 0),
    caminho_copia     VARCHAR(255),
    criptografar      BOOLEAN NOT NULL DEFAULT false,
    compactar         BOOLEAN NOT NULL DEFAULT false,
    criado_em         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE execucoes (
    id                     SERIAL PRIMARY KEY,
    config_id              INTEGER NOT NULL REFERENCES configuracoes_backup(id),
    data_inicio             TIMESTAMP NOT NULL DEFAULT now(),
    data_fim                TIMESTAMP,
    decisao_manutencao     VARCHAR(30) CHECK (decisao_manutencao IN ('NENHUMA','VACUUM','VACUUM_ANALYZE','VACUUM_FULL_ANALYZE')),
    regra_aplicada         VARCHAR(255),
    status                 VARCHAR(20) NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','sucesso','falha')),
    resultado               VARCHAR(255),
    CONSTRAINT chk_execucao_datas CHECK (
        data_fim IS NULL OR data_fim >= data_inicio
    ),
    CONSTRAINT chk_execucao_sucesso_completo CHECK (
        status <> 'sucesso'
        OR (data_fim IS NOT NULL AND NULLIF(BTRIM(resultado), '') IS NOT NULL)
    )
);

CREATE TABLE logs_execucao (
    id             SERIAL PRIMARY KEY,
    execucao_id    INTEGER NOT NULL REFERENCES execucoes(id) ON DELETE CASCADE,
    etapa          VARCHAR(100) NOT NULL,
    mensagem       VARCHAR(500) NOT NULL,
    data           TIMESTAMP NOT NULL DEFAULT now(),
    saida_tecnica  TEXT
);

-- Controle isolado dos cenarios de demonstracao; nao altera dados da loja.
CREATE TABLE cenarios_demonstracao_manutencao (
    id UUID PRIMARY KEY,
    chave VARCHAR(40) NOT NULL CHECK (chave IN ('menos_30', 'entre_30_60', 'acima_60', 'sem_historico')),
    data_ultima_manutencao TIMESTAMP,
    preparado_em TIMESTAMP NOT NULL DEFAULT now(),
    consumido_em TIMESTAMP,
    execucao_id INTEGER REFERENCES execucoes(id) ON DELETE SET NULL
);

ALTER TABLE execucoes
    ADD COLUMN cenario_demonstracao_id UUID REFERENCES cenarios_demonstracao_manutencao(id),
    ADD COLUMN cenario_demonstracao VARCHAR(80),
    ADD COLUMN historico_manutencao_em TIMESTAMP,
    ADD COLUMN dias_desde_manutencao NUMERIC(8,2),
    ADD COLUMN manutencao_executada VARCHAR(30),
    ADD COLUMN caminho_arquivo_backup TEXT;

CREATE INDEX idx_execucoes_config ON execucoes(config_id);
CREATE INDEX idx_execucoes_data ON execucoes(data_inicio);
CREATE INDEX idx_logs_execucao ON logs_execucao(execucao_id);
CREATE INDEX idx_cenarios_demo_pendente
    ON cenarios_demonstracao_manutencao(preparado_em DESC)
    WHERE consumido_em IS NULL;
