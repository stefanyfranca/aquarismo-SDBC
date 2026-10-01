-- Dados isolados para preparar um historico de manutencao de demonstracao.
-- Nenhuma tabela de negocio da loja e alterada por este recurso.
CREATE TABLE IF NOT EXISTS cenarios_demonstracao_manutencao (
    id UUID PRIMARY KEY,
    chave VARCHAR(40) NOT NULL CHECK (chave IN ('menos_30', 'entre_30_60', 'acima_60', 'sem_historico')),
    data_ultima_manutencao TIMESTAMP,
    preparado_em TIMESTAMP NOT NULL DEFAULT now(),
    consumido_em TIMESTAMP,
    execucao_id INTEGER REFERENCES execucoes(id) ON DELETE SET NULL
);

ALTER TABLE execucoes
    ADD COLUMN IF NOT EXISTS cenario_demonstracao_id UUID REFERENCES cenarios_demonstracao_manutencao(id),
    ADD COLUMN IF NOT EXISTS cenario_demonstracao VARCHAR(80),
    ADD COLUMN IF NOT EXISTS historico_manutencao_em TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dias_desde_manutencao NUMERIC(8,2),
    ADD COLUMN IF NOT EXISTS manutencao_executada VARCHAR(30),
    ADD COLUMN IF NOT EXISTS caminho_arquivo_backup TEXT;

CREATE INDEX IF NOT EXISTS idx_cenarios_demo_pendente
    ON cenarios_demonstracao_manutencao(preparado_em DESC)
    WHERE consumido_em IS NULL;
