-- Consolidação de índices: contacts, deals, automation_logs.
--
-- Base: pg_stat_user_indexes de produção (uptime 12d, virada de mês 31/ago
-- inclusa). Todos abaixo com idx_scan = 0, OU prefixo estrito de um índice
-- composto muito mais usado. Verificados contra o código.
--
-- DROP INDEX é metadata-only. IF EXISTS = idempotente.

-- ── contacts (21 -> ~9 índices; ~90 MB) ──────────────────────────────
-- contacts é escrita em todo webhook — cada índice a menos é custo de
-- INSERT/UPDATE economizado.
DROP INDEX IF EXISTS "contacts_organizationId_updatedAt_idx";        -- 0 scans, 24 MB
DROP INDEX IF EXISTS "contacts_organizationId_whatsappJid_idx";      -- 0 (inbound usa whatsapp_bsuid)
DROP INDEX IF EXISTS "contacts_organizationId_leadScore_idx";        -- 0
DROP INDEX IF EXISTS "contacts_organizationId_companyId_idx";        -- 0
DROP INDEX IF EXISTS "contacts_organizationId_assignedToId_idx";     -- 0, prefixo de (org,assignedToId,lifecycleStage)
-- órfãos sem escopo de org (a app sempre filtra por organizationId):
DROP INDEX IF EXISTS "contacts_lifecycleStage_idx";                  -- 0
DROP INDEX IF EXISTS "contacts_whatsappJid_idx";                     -- 0
DROP INDEX IF EXISTS "contacts_leadScore_idx";                       -- 0
DROP INDEX IF EXISTS "contacts_email_idx";                           -- 0 (email_trgm + (org,email) cobrem)
DROP INDEX IF EXISTS "contacts_ad_utm_campaign_idx";                 -- 0
DROP INDEX IF EXISTS "contacts_assignedToId_lifecycleStage_idx";     -- 0
DROP INDEX IF EXISTS "contacts_org_phone_digits_rev_idx";            -- 0, 14 MB (a variante _pattern_ é a usada em busca)

-- ── deals ───────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "deals_organizationId_stageId_idx";  -- 12 scans, prefixo de (org,stageId,status) 2,6M
DROP INDEX IF EXISTS "deals_organizationId_dealRole_idx"; -- 0
DROP INDEX IF EXISTS "deals_organizationId_orgUnitId_idx"; -- 0
DROP INDEX IF EXISTS "deals_orgUnitId_idx";               -- 0 (sem org scope)
DROP INDEX IF EXISTS "deals_stageId_position_idx";        -- 3 scans, 14 MB; (org,stageId,position) tem 101k

-- ── automation_logs (tabela ~850 MB, idx_scan total ~10k) ────────────
DROP INDEX IF EXISTS "automation_logs_dealId_idx";            -- 0, 15 MB
DROP INDEX IF EXISTS "automation_logs_metaWebhookEventId_idx"; -- 0, 12 MB
DROP INDEX IF EXISTS "automation_logs_automationId_idx";      -- 81 scans, prefixo de (automationId,executedAt) e (automationId,stepId)
