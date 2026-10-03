# Deploy seguro — migrations, sweepers e parada graciosa

Guia do operador para os serviços do backend (Easypanel/Docker Swarm). Todos
usam a mesma imagem e se diferenciam por `APP_MODE`.

## 1. Migrations

Quem migra: só `APP_MODE=api`, e só com `RUN_MIGRATIONS_ON_BOOT` ligado
(default). Workers e `api-public` nunca migram.

| Variável | Default | Efeito |
|----------|---------|--------|
| `RUN_MIGRATIONS_ON_BOOT` | ligado | `0`/`false`/`no`/`off` desliga o `migrate deploy` no boot da API |
| `SKIP_PRISMA_MIGRATE` | desligado | legado; `1`/`true`/`yes`/`on` também pula |

Falha do `prisma migrate deploy` → o container **não sobe** (exit 1). O log traz
a saída do Prisma e a linha `migration com falha: <nome>`. Nada é reexecutado:
o fallback antigo (rodar todos os `migration.sql` com `db execute`, ignorando
erro) foi removido — ele reaplicava UPDATEs de tabela inteira e recriava
índices em tabelas grandes.

### Desligar a migration no boot

Desligue (`RUN_MIGRATIONS_ON_BOOT=0` no serviço `api`) quando:

- a API tiver 2 ou mais réplicas — as réplicas compartilham as variáveis, então
  não dá para ligar em uma só; aplique por job ou à mão;
- o operador aplicar as migrations à mão antes do deploy (SQL demorado,
  índice `CONCURRENTLY`, janela de manutenção).

Aplicação manual (no diretório do backend, com o código novo já na máquina):

```bash
node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma
```

Concorrência: o `migrate deploy` do Prisma 6 pega o lock consultivo
`pg_advisory_lock(72707369)` antes de aplicar (timeout de 10 s, erro `P1002`).
Duas réplicas não aplicam a mesma migration; a que perde o lock sai com 1 e
reinicia até a outra terminar. Não defina `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`.

### Recuperar migration que falhou (P3009 / P3018)

Não há automação — é decisão do operador:

1. Ver o erro no log do boot e o estado:
   `node /opt/prisma-cli/node_modules/prisma/build/index.js migrate status --schema=prisma/schema.prisma`
2. Corrigir o banco: aplicar o que faltou da migration ou desfazer o parcial.
3. Marcar o desfecho:
   - `... migrate resolve --applied <nome>` — o SQL já está todo no banco;
   - `... migrate resolve --rolled-back <nome>` — foi desfeito; o próximo
     `migrate deploy` aplica de novo.
4. Reiniciar o serviço `api`.

Para subir sem migrar, sob responsabilidade do operador: `RUN_MIGRATIONS_ON_BOOT=0`.
