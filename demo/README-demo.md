# Banco de demonstração — SBAC

Scripts para criar um banco de demonstração **apenas para testar e demonstrar** a plataforma SBAC. A aplicação **não importa, referencia nem exige** estas tabelas.

## Como usar

```bash
# Criar o banco (ajuste usuário/senha conforme seu ambiente)
createdb -U postgres sbac_demo

# Criar o esquema
psql -U postgres -d sbac_demo -f schema.sql

# Popular com dados fictícios (generate_series)
psql -U postgres -d sbac_demo -f seed.sql
```

## Dados gerados

- ~200 clientes
- 12 espécies
- 60 lotes
- 30 produtos
- 500 pedidos com itens e movimentações de estoque coerentes

## Importante

Este banco é **separado** e **não é usado pela aplicação**. A plataforma SBAC funciona com qualquer banco PostgreSQL, inclusive um vazio.
