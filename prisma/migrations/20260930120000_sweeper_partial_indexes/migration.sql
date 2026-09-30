-- Índices parciais para os sweepers cross-org (BD-4 da auditoria de banco).
--
-- Os três rodam sem filtro de org e por colunas que só apareciam depois de
-- organizationId/userId nos índices existentes — seq scan periódico:
--
--   system_usage_sessions    UPDATE ... WHERE "endedAt" IS NULL AND "lastHeartbeatAt" < X   (60 s)
--   system_activity_sessions UPDATE ... WHERE "endedAt" IS NULL AND "lastActivityAt" < X    (60 s)
--   activity_outbox          SELECT ... WHERE "processedAt" IS NULL AND "deadLetterAt" IS NULL
--                            AND "scheduledFor" <= now ORDER BY "scheduledFor"             (5 s)
--
-- Cada índice cobre só as linhas abertas (sessão ainda ativa / outbox ainda
-- não processada), então fica minúsculo e o predicado do sweeper bate
-- inteiro nele. Junto, o projetor passa a chamar cleanupActivityOutbox
-- (1x/dia) para a outbox parar de crescer sem limite.
--
-- Em produção, tabelas grandes: preferir o equivalente CONCURRENTLY à mão
-- antes do `migrate deploy` (IF NOT EXISTS deixa esta migration no-op):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "system_usage_sessions_open_heartbeat_idx"
--     ON "system_usage_sessions" ("lastHeartbeatAt") WHERE "endedAt" IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "system_activity_sessions_open_activity_idx"
--     ON "system_activity_sessions" ("lastActivityAt") WHERE "endedAt" IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_outbox_pending_scheduled_idx"
--     ON "activity_outbox" ("scheduledFor") WHERE "processedAt" IS NULL AND "deadLetterAt" IS NULL;

CREATE INDEX IF NOT EXISTS "system_usage_sessions_open_heartbeat_idx"
  ON "system_usage_sessions" ("lastHeartbeatAt")
  WHERE "endedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "system_activity_sessions_open_activity_idx"
  ON "system_activity_sessions" ("lastActivityAt")
  WHERE "endedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "activity_outbox_pending_scheduled_idx"
  ON "activity_outbox" ("scheduledFor")
  WHERE "processedAt" IS NULL AND "deadLetterAt" IS NULL;
