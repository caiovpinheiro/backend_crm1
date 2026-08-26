-- Índice de reabastecimento do rodízio de envio de campanhas.
--
-- Rodar manualmente em produção (fora do prisma migrate):
--   psql "$DATABASE_URL" -f prisma/scripts/create-campaign-roundrobin-index.sql
--
-- Motivo: com CAMPAIGN_SEND_ROUND_ROBIN=1, o sendWorker deixa de consumir a
-- fila FIFO `campaign-send` do BullMQ e passa a reivindicar (claim) lotes de
-- recipients PENDING direto no Postgres, por org, em rodízio com crédito:
--
--   SELECT r.id FROM campaign_recipients r
--    JOIN campaigns c ON c.id = r."campaignId"
--   WHERE r."organizationId" = $1 AND r.status = 'PENDING'
--     AND c.status IN ('SENDING','PROCESSING')
--   ORDER BY r.id LIMIT $n
--   FOR UPDATE OF r SKIP LOCKED
--
-- O índice (organizationId, status, id) atende equality nas duas primeiras
-- colunas e devolve os ids JÁ ORDENADOS (keyset, sem sort nem OFFSET) — é o
-- que mantém o claim O(limite) mesmo com centenas de milhares de PENDING.
-- A listagem de orgs com pendência (loose index scan via CTE recursiva no
-- worker) usa o mesmo índice pelo prefixo organizationId.
--
-- Por que NÃO (organizationId, status, campaignId, id): o claim não filtra
-- campaignId; com campaignId no meio, o ORDER BY id exigiria merge/sort dos
-- grupos por campanha a cada lote.
--
-- CREATE INDEX CONCURRENTLY não roda dentro de transaction — por isso este
-- script não é uma migration do Prisma.
--
-- Verificação de índice equivalente já existente (prefixo basta):
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'campaign_recipients'
   AND indexdef ILIKE '%(organizationId, status%';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "campaign_recipients_org_status_id_idx"
  ON "campaign_recipients" ("organizationId", "status", "id");
