-- Índices da 2ª auditoria (02/10/2026): retenção de meta_webhook_events e dashboard.
--
-- 1) automation_logs ("metaWebhookEventId") parcial — a FK
--    automation_logs_metaWebhookEventId_fkey (ON DELETE SET NULL) ficou sem
--    índice em 20260911220000_db_index_hygiene. Cada DELETE de
--    meta_webhook_events passa a varrer automation_logs (~1,4 M linhas) para
--    zerar a referência; o lote estoura o timeout de 30 s e a tabela (~3,3 GB)
--    só cresce. Parcial: a coluna é NULL na grande maioria das linhas.
--
-- 2) meta_webhook_events ("receivedAt") — a retenção apaga por data sem org;
--    os índices existentes começam por organizationId/processed/channelId.
--
-- 3) deal_events ("organizationId", type, "createdAt") — o dashboard faz três
--    consultas em deal_events por tipo (STAGE_CHANGED, CREATED) e janela de data.
--
-- Em produção (tabelas grandes) criar ANTES do `migrate deploy`, um comando por
-- vez, com Auto commit ligado (IF NOT EXISTS deixa esta migration no-op):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_logs_meta_webhook_event_id_idx"
--     ON "automation_logs" ("metaWebhookEventId") WHERE "metaWebhookEventId" IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_webhook_events_received_at_idx"
--     ON "meta_webhook_events" ("receivedAt");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "deal_events_org_type_created_at_idx"
--     ON "deal_events" ("organizationId", "type", "createdAt");

CREATE INDEX IF NOT EXISTS "automation_logs_meta_webhook_event_id_idx"
  ON "automation_logs" ("metaWebhookEventId")
  WHERE "metaWebhookEventId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "meta_webhook_events_received_at_idx"
  ON "meta_webhook_events" ("receivedAt");

CREATE INDEX IF NOT EXISTS "deal_events_org_type_created_at_idx"
  ON "deal_events" ("organizationId", "type", "createdAt");
