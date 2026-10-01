# Relatorio de funcionamento: manutencao, backup e restauracao

Data: 30/09/2026

## Validacao da decisao de manutencao

Os testes automatizados passaram. A regra retorna `NENHUMA` antes de 30 dias, `VACUUM` de 30 ate 60 dias inclusive, e `VACUUM_FULL_ANALYZE` acima de 60 dias ou quando nao existe manutencao anterior valida. Os testes cobrem 29, 30, 45, 60, 61 dias e historico ausente.

## Execucao real no PostgreSQL local

O backend conectou ao PostgreSQL 18.3, banco `aquarismo_sdbc`. A primeira execucao foi manual pela API; como nao havia manutencao no historico, o sistema escolheu e executou `VACUUM FULL ANALYZE`, depois chamou `pg_dump`.

- Execucao: `#1`
- Status: `sucesso`
- Regra: sem historico de manutencao com data valida
- Arquivo gerado: `backups/backup-aquarismo_sdbc-2026-09-30T23-42-47-003Z.dump`
- Tamanho: 5.050.166 bytes
- Etapas persistidas: validacao, manutencao, backup, retencao e finalizacao

A pasta `backups/` e ignorada pelo Git. A configuracao local usa o `pg_dump.exe` e `pg_restore.exe` instalados com o PostgreSQL, e mantem compactacao/criptografia desativadas por padrao porque o 7-Zip e as chaves opcionais nao estao configurados.

## Restauracao e verificacao

O backup foi restaurado pelo novo comando `npm run restore` em um banco separado, `aquarismo_sdbc_restaurado_validado`; o banco original nao foi sobrescrito. A restauracao terminou com `status=validado`.

As contagens foram iguais para os dados da loja: 30.000 clientes, 15 especies, 10.000 lotes, 2.000 produtos, 70.000 pedidos, 140.000 itens e 247.984 movimentacoes. As tabelas de controle podem diferir porque o processo grava logs e finaliza a execucao depois do instante em que o dump foi capturado; a validacao informa essas contagens separadamente.

## Integracao verificada

- `GET /api/health`: HTTP 200 e PostgreSQL conectado.
- `GET /api/configuracoes`: retorna configuracao persistida no PostgreSQL.
- `GET /api/execucoes`: retorna historico real, nao dados mockados.
- `GET /api/execucoes/1`: retorna sucesso e cinco logs persistidos.
- `GET /api/execucoes/1/eventos`: SSE para progresso durante novas execucoes.
- Tela de configuracoes salva no banco; tela de historico e tela de logs leem a API.

## Requisitos locais

As variaveis de ambiente em `backend/.env` apontam para uma raiz de backup dedicada dentro do projeto e para as ferramentas PostgreSQL. Nao exponha nem versione esse arquivo. Para compactacao, configure 7-Zip e senha; para criptografia, configure uma chave AES-256 base64. O comando de restauracao atual aceita arquivo `.dump` custom sem compactacao/criptografia.
