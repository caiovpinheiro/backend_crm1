# Worker Meta Webhook — guia de deploy (EasyPanel)

Worker dedicado (`APP_MODE=worker-meta-webhook`) que processa webhooks Meta a
partir de `meta_webhook_events` via BullMQ. A API passa a apenas validar
assinatura, persistir o evento, enfileirar e responder 200 — a tempestade de
status de campanha sai do processo do inbox.

## Arquitetura

```
Meta Webhook → backend-api
  api → valida assinatura + insert meta_webhook_events → Postgres
  api → enqueue → Redis (BullMQ meta-webhook-events)
  api → 200 accepted → Meta
Redis → worker-meta-webhook → processa rawBody → Postgres (processed=true)
```

## 1. Criar o serviço no EasyPanel

Novo serviço **`worker-meta-webhook`** (prod e dev):

| Campo | Valor |
|---|---|
| Source | Docker Image |
| Image | `ghcr.io/mikyxx1234/backend_crm1:latest` (prod) / `:dev` (dev) |
| Registry | mesma credential GHCR dos outros serviços |

**Env vars** (mesmas do `backend-api`):
- `DATABASE_URL`, `REDIS_URL` (obrigatórias) — hostname **`private-*`**
  (VPC). Hostname sem `private-` ou IP público sai pela internet.
  Postgres: `…@private-crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060/…?sslmode=require`.
  Valkey: `rediss://…@private-crm1-valkey-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25061`.
- Meta/storage: `STORAGE_ROOT`, `META_*` (o worker baixa mídia inbound)
- `APP_MODE=worker-meta-webhook`
- `DB_POOL_MAX=4` (recomendado; default código = 4 para workers não-whatsapp)
- `META_WEBHOOK_WORKER_CONCURRENCY=4` (≤ `DB_POOL_MAX` — senão pg-pool timeout)

**Não** setar `SKIP_PRISMA_MIGRATE` — o entrypoint já pula migrations para
qualquer `APP_MODE != api`.

### Pool Postgres (checklist multi-serviço)

| Serviço | `APP_MODE` | `DB_POOL_MAX` | concurrency relacionada |
|---|---|---|---|
| backend-api | `api` | `20` | — |
| worker-whatsapp | `worker-whatsapp` | `6` | `CAMPAIGN_SEND_CONCURRENCY=4` |
| worker-meta-webhook | `worker-meta-webhook` | `4` | `META_WEBHOOK_WORKER_CONCURRENCY=4` |
| worker-automation | `worker-automation` | `4` | `AUTOMATION_WORKER_CONCURRENCY=4` |

Erro `timeout exceeded when trying to connect` = esgotamento do **pg-pool**
(ou Postgres `max_connections`), não timeout de delivery Meta nem curl 28
do deploy hook EasyPanel. Log de diagnóstico:
`[prisma-base] pool exhausted APP_MODE=worker-meta-webhook ...`.

## 2. Deploy hook no GitHub

Settings do serviço → Deployments → Deploy Hook → copiar URL e cadastrar:

- Prod: secret `EASYPANEL_WEBHOOK_PROD_WORKER_META_WEBHOOK`
- Dev: secret `EASYPANEL_WEBHOOK_DEV_WORKER_META_WEBHOOK`

O workflow `build-and-deploy.yml` já inclui esses secrets na lista; secret
ausente é ignorado (rollout por partes).

## 3. Rollout seguro

1. **Deploy do worker primeiro** (fila vazia, sem consumo): push → imagem
   publicada → EasyPanel sobe `worker-meta-webhook`. Nada muda ainda.
2. **Deploy da API** com enqueue ativo (`META_WEBHOOK_ASYNC` default = ligado).
3. **Observar**:
   - `SELECT count(*) FROM meta_webhook_events WHERE processed = false` — lag
     deve ficar próximo de 0 (worker drena em tempo real).
   - Logs `worker.meta-webhook` / `[entrypoint] starting Meta Webhook worker`.
   - Latência da rota POST `/api/webhooks/meta*` (<100ms).
4. **Rollback imediato** (sem redeploy do worker): setar `META_WEBHOOK_ASYNC=0`
   no serviço `backend-api` e reiniciar — a API volta a processar síncrono.
   O worker fica ocioso (fila para de receber jobs).

## 4. Recovery de backlog

Se o worker ficar fora do ar, eventos acumulam com `processed=false`. Ao
religar, apenas os **novos** são consumidos da fila. Para drenar o backlog
persistido, re-enfileire via SQL + script (ou endpoint admin futuro):

```sql
SELECT id, "organizationId" FROM meta_webhook_events
WHERE processed = false ORDER BY "receivedAt" ASC LIMIT 1000;
```

O índice `meta_webhook_events_processed_receivedAt_idx` (migration
`20260811190000_meta_webhook_processed_idx`) torna essa query barata.

## 5. Verificação

- POST webhook → 200 em <100ms na API (`status: "accepted"`).
- Status de campanha processado pelo worker (logs `worker.meta-webhook`).
- Inbox `GET /api/conversations` estável durante disparo de teste.
