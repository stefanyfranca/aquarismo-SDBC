-- Execute este arquivo apenas em bancos já criados com uma versão anterior do schema.
-- O schema.sql novo já contém estas validações.
ALTER TABLE configuracoes_backup
    ADD CONSTRAINT chk_configuracoes_qtd_manter_positiva CHECK (qtd_manter > 0);

ALTER TABLE execucoes
    ADD CONSTRAINT chk_execucao_datas CHECK (data_fim IS NULL OR data_fim >= data_inicio),
    ADD CONSTRAINT chk_execucao_sucesso_completo CHECK (
        status <> 'sucesso'
        OR (data_fim IS NOT NULL AND NULLIF(BTRIM(resultado), '') IS NOT NULL)
    );
