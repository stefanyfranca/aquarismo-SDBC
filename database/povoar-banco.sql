BEGIN;

TRUNCATE TABLE
    logs_execucao,
    execucoes,
    configuracoes_backup,
    movimentacoes_estoque,
    itens_pedido,
    pedidos,
    lotes,
    produtos_acessorios,
    especies,
    clientes
RESTART IDENTITY CASCADE;

INSERT INTO especies (
    nome_popular,
    nome_cientifico,
    categoria,
    nivel_dificuldade
)
VALUES
    ('Betta', 'Betta splendens', 'peixe', 'facil'),
    ('Neon Tetra', 'Paracheirodon innesi', 'peixe', 'facil'),
    ('Peixe-palhaço', 'Amphiprion ocellaris', 'peixe', 'medio'),
    ('Guppy', 'Poecilia reticulata', 'peixe', 'facil'),
    ('Acará-bandeira', 'Pterophyllum scalare', 'peixe', 'medio'),
    ('Molinésia', 'Poecilia sphenops', 'peixe', 'facil'),
    ('Peixe-dourado', 'Carassius auratus', 'peixe', 'facil'),
    ('Camarão Neocaridina', 'Neocaridina davidi', 'invertebrado', 'medio'),
    ('Caramujo Neritina', 'Neritina natalensis', 'invertebrado', 'facil'),
    ('Anúbia', 'Anubias barteri', 'planta', 'facil'),
    ('Musgo de Java', 'Taxiphyllum barbieri', 'planta', 'facil'),
    ('Cabomba', 'Cabomba caroliniana', 'planta', 'medio'),
    ('Elódea', 'Egeria densa', 'planta', 'facil'),
    ('Amazonense', 'Echinodorus amazonicus', 'planta', 'medio'),
    ('Rabo de Raposa', 'Ceratophyllum demersum', 'planta', 'facil');


INSERT INTO clientes (
    nome,
    email,
    telefone
)
SELECT
    CASE (g % 12)
        WHEN 0 THEN 'Ana'
        WHEN 1 THEN 'Bruno'
        WHEN 2 THEN 'Camila'
        WHEN 3 THEN 'Daniel'
        WHEN 4 THEN 'Eduarda'
        WHEN 5 THEN 'Felipe'
        WHEN 6 THEN 'Gabriela'
        WHEN 7 THEN 'Henrique'
        WHEN 8 THEN 'Isabela'
        WHEN 9 THEN 'João'
        WHEN 10 THEN 'Larissa'
        ELSE 'Marcos'
    END
    || ' ' ||
    CASE (g % 10)
        WHEN 0 THEN 'Silva'
        WHEN 1 THEN 'Santos'
        WHEN 2 THEN 'Oliveira'
        WHEN 3 THEN 'Souza'
        WHEN 4 THEN 'Pereira'
        WHEN 5 THEN 'Costa'
        WHEN 6 THEN 'Rodrigues'
        WHEN 7 THEN 'Almeida'
        WHEN 8 THEN 'Ferreira'
        ELSE 'Martins'
    END
    || ' ' || g,

    'cliente' || g || '@aquarismo.test',

    '(48) 9' ||
    LPAD((10000000 + g)::TEXT, 8, '0')

FROM generate_series(1, 30000) AS g;


INSERT INTO produtos_acessorios (
    nome,
    categoria,
    preco,
    estoque_atual
)
SELECT
    CASE (g % 4)
        WHEN 0 THEN 'Ração Premium para Peixes'
        WHEN 1 THEN 'Filtro Externo para Aquário'
        WHEN 2 THEN 'Decoração Artificial'
        ELSE 'Equipamento de Iluminação'
    END
    || ' Modelo ' || g,

    CASE (g % 4)
        WHEN 0 THEN 'racao'
        WHEN 1 THEN 'filtro'
        WHEN 2 THEN 'decoracao'
        ELSE 'equipamento'
    END,

    ROUND((20 + (g % 300) * 1.75)::NUMERIC, 2),

    1000

FROM generate_series(1, 2000) AS g;



INSERT INTO lotes (
    especie_id,
    fornecedor,
    data_chegada,
    quantidade_inicial,
    quantidade_atual,
    preco_unitario
)
SELECT
    ((g - 1) % 15) + 1,

    CASE (g % 6)
        WHEN 0 THEN 'Fornecedor Aquatic Life'
        WHEN 1 THEN 'Distribuidora Tropical'
        WHEN 2 THEN 'Mundo dos Aquários'
        WHEN 3 THEN 'Oceanic Brasil'
        WHEN 4 THEN 'Vida Aquática'
        ELSE 'Importadora Marinha'
    END,

    CURRENT_DATE - ((g % 720)::INTEGER),

    1000,

    1000,

    ROUND((5 + (g % 200) * 0.85)::NUMERIC, 2)

FROM generate_series(1, 10000) AS g;


INSERT INTO pedidos (
    cliente_id,
    data_pedido,
    status,
    total
)
SELECT
    ((g - 1) % 30000) + 1,

    TIMESTAMP '2025-01-01'
        + ((g % 630) * INTERVAL '1 day')
        + ((g % 86400) * INTERVAL '1 second'),

    CASE (g % 10)
        WHEN 0 THEN 'cancelado'
        WHEN 1 THEN 'pendente'
        WHEN 2 THEN 'pago'
        ELSE 'enviado'
    END,

    0

FROM generate_series(1, 70000) AS g;


INSERT INTO itens_pedido (
    pedido_id,
    tipo_item,
    lote_id,
    produto_id,
    quantidade,
    preco_unitario
)
SELECT
    ((g - 1) % 70000) + 1,

    CASE
        WHEN g % 2 = 0 THEN 'peixe'
        ELSE 'acessorio'
    END,

    CASE
        WHEN g % 2 = 0
        THEN ((g - 1) % 10000) + 1
        ELSE NULL
    END,

    CASE
        WHEN g % 2 = 0
        THEN NULL
        ELSE ((g - 1) % 2000) + 1
    END,

    1 + (g % 5),

    CASE
        WHEN g % 2 = 0
        THEN (
            SELECT preco_unitario
            FROM lotes
            WHERE id = ((g - 1) % 10000) + 1
        )
        ELSE (
            SELECT preco
            FROM produtos_acessorios
            WHERE id = ((g - 1) % 2000) + 1
        )
    END

FROM generate_series(1, 140000) AS g;


UPDATE pedidos p
SET total = COALESCE(
    (
        SELECT SUM(i.quantidade * i.preco_unitario)
        FROM itens_pedido i
        WHERE i.pedido_id = p.id
    ),
    0
);


INSERT INTO movimentacoes_estoque (
    lote_id,
    produto_id,
    tipo,
    quantidade,
    data,
    observacao
)
SELECT
    ((g - 1) % 10000) + 1,

    NULL,

    CASE
        WHEN g % 10 IN (0, 1) THEN 'venda'
        WHEN g % 10 IN (2, 3) THEN 'perda'
        ELSE 'entrada'
    END,

    1 + (g % 5),

    TIMESTAMP '2025-01-01'
        + ((g % 630) * INTERVAL '1 day')
        + ((g % 86400) * INTERVAL '1 second'),

    CASE
        WHEN g % 10 IN (0, 1)
            THEN 'Venda de animais aquáticos'
        WHEN g % 10 IN (2, 3)
            THEN 'Perda registrada no estoque'
        ELSE 'Entrada de novo lote'
    END

FROM generate_series(1, 123992) AS g;


INSERT INTO movimentacoes_estoque (
    lote_id,
    produto_id,
    tipo,
    quantidade,
    data,
    observacao
)
SELECT
    NULL,

    ((g - 1) % 2000) + 1,

    CASE
        WHEN g % 10 IN (0, 1) THEN 'venda'
        WHEN g % 10 IN (2, 3) THEN 'perda'
        ELSE 'entrada'
    END,

    1 + (g % 5),

    TIMESTAMP '2025-01-01'
        + ((g % 630) * INTERVAL '1 day')
        + ((g % 86400) * INTERVAL '1 second'),

    CASE
        WHEN g % 10 IN (0, 1)
            THEN 'Venda de acessório'
        WHEN g % 10 IN (2, 3)
            THEN 'Perda registrada no estoque'
        ELSE 'Entrada de produtos'
    END

FROM generate_series(1, 123992) AS g;


UPDATE lotes l
SET quantidade_atual = GREATEST(
    0,
    l.quantidade_inicial
    +
    COALESCE(
        (
            SELECT SUM(
                CASE
                    WHEN m.tipo = 'entrada' THEN m.quantidade
                    WHEN m.tipo IN ('venda', 'perda')
                        THEN -m.quantidade
                    ELSE 0
                END
            )
            FROM movimentacoes_estoque m
            WHERE m.lote_id = l.id
        ),
        0
    )
);


UPDATE produtos_acessorios p
SET estoque_atual = GREATEST(
    0,
    1000
    +
    COALESCE(
        (
            SELECT SUM(
                CASE
                    WHEN m.tipo = 'entrada' THEN m.quantidade
                    WHEN m.tipo IN ('venda', 'perda')
                        THEN -m.quantidade
                    ELSE 0
                END
            )
            FROM movimentacoes_estoque m
            WHERE m.produto_id = p.id
        ),
        0
    )
);


INSERT INTO configuracoes_backup (
    banco,
    caminho_destino,
    qtd_manter,
    caminho_copia,
    criptografar,
    compactar
)
VALUES (
    'aquarismo',
    '/var/backups/aquarismo',
    7,
    '/var/backups/aquarismo/copia',
    false,
    true
);


DO $$
DECLARE
    total_registros BIGINT;
BEGIN
    SELECT
        (SELECT COUNT(*) FROM especies)
        + (SELECT COUNT(*) FROM clientes)
        + (SELECT COUNT(*) FROM produtos_acessorios)
        + (SELECT COUNT(*) FROM lotes)
        + (SELECT COUNT(*) FROM pedidos)
        + (SELECT COUNT(*) FROM itens_pedido)
        + (SELECT COUNT(*) FROM movimentacoes_estoque)
        + (SELECT COUNT(*) FROM configuracoes_backup)
        + (SELECT COUNT(*) FROM execucoes)
        + (SELECT COUNT(*) FROM logs_execucao)
    INTO total_registros;

    RAISE NOTICE '=========================================';
    RAISE NOTICE 'TOTAL DE REGISTROS: %', total_registros;
    RAISE NOTICE 'TOTAL ESPERADO: 500000';
    RAISE NOTICE '=========================================';
END $$;

COMMIT;