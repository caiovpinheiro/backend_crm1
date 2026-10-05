-- Índices mortos (C5 da auditoria de banco, 05/10).
--
-- Base: pg_stat_user_indexes de produção, janela 29/09 23:12 UTC → 05/10
-- (5,9 dias), idx_scan = 0, e conferidos contra o código da DEV_BRANCH:
-- nenhum `where`/`orderBy` do Prisma nem SQL cru os alcança, e nenhum
-- sustenta uma FK usada pelo app. A tabela completa (com os que FICAM e por
-- quê) está no corpo do PR. ~520 MB no total.
--
-- 1) meta_webhook_events ("organizationId", "receivedAt" DESC) — 338 MB.
--    A tabela só é lida por `id` (processStoredMetaWebhookEvent) e apagada
--    por "receivedAt" (services/db-retention.ts). Não existe tela/rota que
--    liste eventos por organização. A FK de organizationId (ON DELETE SET
--    NULL) só dispara ao apagar uma organização, o que o app não faz
--    (só testes de integração e seed).
--
-- 2) meta_webhook_events ("processed", "receivedAt") — 156 MB. Criado para
--    o "recovery de backlog" do runbook (docs/worker-meta-webhook-deploy.md
--    §4: `WHERE processed = false ORDER BY "receivedAt"`), consulta MANUAL —
--    nenhum código filtra por `processed`. Indexava os 3,7 M de eventos para
--    servir os poucos não processados. TROCADO pelo parcial
--    "meta_webhook_events_unprocessed_idx" ("receivedAt") WHERE processed =
--    false: mesma consulta do runbook, alguns kB em vez de 156 MB. A
--    retenção (`"receivedAt" < $1 AND "processed" = true`) usa
--    meta_webhook_events_receivedAt_idx.
--
-- 3) system_activity_sessions ("organizationId", "lastActivityAt") — 19 MB.
--    As consultas da tabela são por (org, userId, endedAt), (org, startedAt)
--    e o sweeper usa o parcial system_activity_sessions_open_activity_idx
--    ("lastActivityAt") WHERE "endedAt" IS NULL. Nada combina org com
--    lastActivityAt. Cada heartbeat de atividade atualiza lastActivityAt —
--    este índice era reescrito a cada um deles.
--
-- 4) contacts ("ad_ctwa_clid") — 7 MB. A coluna é só gravada e devolvida
--    (leads, automações); nenhum lookup por ela.
--
-- FICAM de propósito (0 leituras, mas sustentam FK de DELETE ou a retenção):
--   meta_webhook_events_channelId_idx, meta_webhook_events_receivedAt_idx,
--   messages_channelId_idx, messages_aiAgentUserId_createdAt_idx,
--   conversations_tabulationId_idx, activity_events_actorUserId_idx,
--   ai_agent_messages_runId_createdAt_idx.
--
-- PRODUÇÃO: `DROP INDEX` sem CONCURRENTLY pede ACCESS EXCLUSIVE na tabela.
-- É rápido, mas ENTRA NA FILA atrás de qualquer consulta em andamento e,
-- enquanto espera, segura todo INSERT novo — e meta_webhook_events recebe
-- todo webhook da Meta. Rode ANTES do deploy, fora de transação, um de cada
-- vez (com eles já removidos, este arquivo não faz nada). O parcial vem
-- PRIMEIRO, para o runbook nunca ficar sem índice:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_webhook_events_unprocessed_idx"
--     ON "meta_webhook_events" ("receivedAt") WHERE "processed" = false;
--
--   -- conferir que ficou válido (se INVALID: DROP INDEX CONCURRENTLY e de novo)
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname = 'meta_webhook_events_unprocessed_idx';
--
--   DROP INDEX CONCURRENTLY IF EXISTS "meta_webhook_events_organizationId_receivedAt_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "meta_webhook_events_processed_receivedAt_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "system_activity_sessions_organizationId_lastActivityAt_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "contacts_ad_ctwa_clid_idx";
--
-- Conferir que saíram (deve voltar zero linhas):
--
--   SELECT indexrelid::regclass FROM pg_index
--    WHERE indexrelid::regclass::text IN (
--      '"meta_webhook_events_organizationId_receivedAt_idx"',
--      '"meta_webhook_events_processed_receivedAt_idx"',
--      '"system_activity_sessions_organizationId_lastActivityAt_idx"',
--      'contacts_ad_ctwa_clid_idx');
--
-- Rollback (recriar; em produção com CONCURRENTLY):
--   DROP INDEX CONCURRENTLY IF EXISTS "meta_webhook_events_unprocessed_idx";
--   CREATE INDEX CONCURRENTLY "meta_webhook_events_organizationId_receivedAt_idx"
--     ON "meta_webhook_events" ("organizationId", "receivedAt" DESC);
--   CREATE INDEX CONCURRENTLY "meta_webhook_events_processed_receivedAt_idx"
--     ON "meta_webhook_events" ("processed", "receivedAt");
--   CREATE INDEX CONCURRENTLY "system_activity_sessions_organizationId_lastActivityAt_idx"
--     ON "system_activity_sessions" ("organizationId", "lastActivityAt");
--   CREATE INDEX CONCURRENTLY "contacts_ad_ctwa_clid_idx"
--     ON "contacts" ("ad_ctwa_clid");

DO $$
BEGIN
  IF to_regclass('"meta_webhook_events_unprocessed_idx"') IS NULL THEN
    CREATE INDEX "meta_webhook_events_unprocessed_idx"
      ON "meta_webhook_events" ("receivedAt")
      WHERE "processed" = false;
  END IF;
END$$;

DROP INDEX IF EXISTS "meta_webhook_events_organizationId_receivedAt_idx";
DROP INDEX IF EXISTS "meta_webhook_events_processed_receivedAt_idx";
DROP INDEX IF EXISTS "system_activity_sessions_organizationId_lastActivityAt_idx";
DROP INDEX IF EXISTS "contacts_ad_ctwa_clid_idx";
