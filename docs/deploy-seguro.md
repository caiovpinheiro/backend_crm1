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

## 2. Sweepers e automação fora da API

Padrão de produção (`NODE_ENV=production`, que o `server.js` do Next sempre
define): a API **não** sobe sweeper e **não** executa automação inline.

| Variável | Vazio (padrão) | Valores |
|----------|----------------|---------|
| `API_RUN_SWEEPERS` | desligado em produção; ligado em dev local | `1` liga na API (só sem os workers); `0` desliga sempre |
| `AUTOMATION_WORKER_MODE` | `external` na `api`/`api-public` em produção; `inline` nos workers e em dev | `external` enfileira em `automation-jobs`; `inline` executa no processo |

O que cada modo sobe (sem nenhuma das duas variáveis):

| Processo | Antes | Depois |
|----------|-------|--------|
| `api` (produção) | timeout de automação + presença, atividade, agendadas, envio travado, inatividade da IA, expiração de sessão WhatsApp, push de alerta, projetores da outbox (tabulação e `CONVERSATION_CLOSED`); automação inline | nenhum sweeper; automação enfileirada |
| `api` com `AUTOMATION_WORKER_MODE=external` | nenhum sweeper; automação enfileirada | igual |
| `api` em dev local (`next dev`) | todos + inline | igual |
| `api-public` | nenhum sweeper; automação inline | nenhum sweeper; automação enfileirada |
| `worker-whatsapp` | presença … projetores da outbox (todos menos o timeout) | igual |
| `worker-automation` | timeout de automação + varredura do admission control; consome `automation-jobs` | igual |
| demais workers | nenhum sweeper; automação inline quando disparada neles | igual |

Pré-requisito em produção: `worker-whatsapp` e `worker-automation` no ar. O log
de boot da API mostra a decisão:
`[sse-bus] sweepers desligados na API — rodam no worker-whatsapp e no worker-automation`.
Rollback sem deploy: `API_RUN_SWEEPERS=1` e `AUTOMATION_WORKER_MODE=inline` no
serviço `api`.

## 3. Parada graciosa (SIGTERM)

### API (`api`, `api-public`)

No SIGTERM (`src/lib/api-shutdown.ts`, instalado em `src/instrumentation.ts`):

1. `/api/health` passa a 503 (`{"status":"draining"}`) e o SSE recusa conexão
   nova com 503 + `Retry-After` (métrica `crm_sse_connections_rejected_total{reason="draining"}`).
2. Streams SSE abertos recebem `retry:` aleatório entre 2 e 15 s e o evento
   `sse_connection_evicted` (`reason: "server_shutdown"`), liberam a vaga no
   Redis e são fechados.
3. Pré-parada de `API_SHUTDOWN_PRESTOP_MS` (5 s) servindo normalmente, para o
   proxy tirar a réplica.
4. O listener HTTP fecha e as requisições em curso terminam.
5. `$disconnect` do Prisma e saída 0. Teto `API_SHUTDOWN_TIMEOUT_MS` (25 s):
   passou, as conexões restantes caem e o processo sai 1.

O entrypoint exporta `NEXT_MANUAL_SIG_HANDLE=true` (o handler do Next esperava
os streams SSE sem teto, até o SIGKILL) e `KEEP_ALIVE_TIMEOUT=95000` (o
keep-alive do Node precisa ser maior que o idle do proxy até o backend:
Traefik 90 s; o Caddy do compose da DO usa 2 min — lá defina `125000`).
`API_GRACEFUL_SHUTDOWN=0` volta ao comportamento do Next.

Gate de card do SSE (V-INF-2): se a montagem do filtro de visibilidade falhar
(pool cheio na reconexão em massa), a conexão nega todos os cards
(`cardOmitted: "hidden"`) e tenta remontar a cada 15–30 s — antes liberava todos.

### Workers

Todos usam `installGracefulShutdown` (`src/workers/graceful-shutdown.ts`):
passos isolados (falha de um não pula os outros), `worker.close()` do BullMQ
(espera o job ativo), sweepers parados, `$disconnect` do Prisma, teto e saída.

| Serviço | Teto | Passos |
|---------|------|--------|
| `worker-whatsapp`, `worker-campaigns` | 25 s | (já existiam) |
| `worker-meta-webhook` | 25 s | sweepers de IA → flush de status → `close()` → flush final → Prisma |
| `worker-distribution` | 25 s | `close()` das duas filas → Prisma |
| `worker-baileys` | 25 s | sweepers de IA → `close()` das filas → sessões → Prisma |
| `worker-etl`, `worker-leads` | 110 s | `close()` → Prisma |
| `worker-automation` | 110 s | sweepers (timeout e admission control) → `close()` → Prisma |

`WORKER_SHUTDOWN_TIMEOUT_MS` sobrescreve o teto de qualquer worker (use ≈
stop_grace − 10 s).

### `stop_grace_period` recomendado

O padrão do Docker é 10 s — menor que qualquer teto acima, então o SIGKILL
chega antes. Configure por serviço:

| Serviço | stop_grace_period |
|---------|-------------------|
| `api`, `api-public` | 35 s |
| `worker-whatsapp`, `worker-campaigns`, `worker-meta-webhook`, `worker-distribution`, `worker-baileys` | 35 s |
| `worker-etl`, `worker-leads`, `worker-automation` | 120 s |

Workers: ordem stop-first (sem "Tempo de inatividade zero", como o entrypoint
já avisa). No Easypanel, use o campo do painel se existir; um
`docker service update --stop-grace-period` feito à mão é desfeito no próximo
redeploy do Easypanel (mesmo problema do `--env-add`). O compose de
`deploy/digitalocean` já traz esses valores.
