-- Higiene de índices: corta prefixos/duplicatas (write tax no inbound) e
-- garante FKs leading-column + índices de busca/campanha que o código já
-- assume. IF EXISTS / IF NOT EXISTS — idempotente se o script manual de
-- prod já aplicou.

-- ── Drops: prefixo de composto, unique duplicado, 0-scan em prod ─────

DROP INDEX IF EXISTS "contacts_organizationId_idx";
DROP INDEX IF EXISTS "contacts_organizationId_number_idx";
DROP INDEX IF EXISTS "contacts_organizationId_lifecycleStage_idx";

DROP INDEX IF EXISTS "deals_organizationId_idx";
DROP INDEX IF EXISTS "deals_organizationId_contactId_idx";

DROP INDEX IF EXISTS "conversations_organizationId_idx";
DROP INDEX IF EXISTS "conversations_organizationId_status_idx";

DROP INDEX IF EXISTS "messages_organizationId_idx";
DROP INDEX IF EXISTS "messages_externalId_idx";

DROP INDEX IF EXISTS "automation_logs_automationId_idx";
DROP INDEX IF EXISTS "automation_logs_dealId_idx";
DROP INDEX IF EXISTS "automation_logs_metaWebhookEventId_idx";

DROP INDEX IF EXISTS "campaign_recipients_organizationId_idx";
DROP INDEX IF EXISTS "campaign_recipients_contactId_idx";

-- ── FKs (1ª coluna = FK) — DELETE do pai sem isto seq-scaneia a filha

CREATE INDEX IF NOT EXISTS "deals_orgUnitId_idx"
  ON "deals" ("orgUnitId");

CREATE INDEX IF NOT EXISTS "activity_events_contactId_idx"
  ON "activity_events" ("contactId");

CREATE INDEX IF NOT EXISTS "activity_events_conversationId_idx"
  ON "activity_events" ("conversationId");

CREATE INDEX IF NOT EXISTS "activity_events_dealId_idx"
  ON "activity_events" ("dealId");

CREATE INDEX IF NOT EXISTS "activity_events_actorUserId_idx"
  ON "activity_events" ("actorUserId");

CREATE INDEX IF NOT EXISTS "conversations_departmentId_idx"
  ON "conversations" ("departmentId");

CREATE INDEX IF NOT EXISTS "conversations_tabulationId_idx"
  ON "conversations" ("tabulationId");

CREATE INDEX IF NOT EXISTS "meta_webhook_events_channelId_idx"
  ON "meta_webhook_events" ("channelId");

CREATE INDEX IF NOT EXISTS "automation_session_expiry_claims_conversationId_idx"
  ON "automation_session_expiry_claims" ("conversationId");

CREATE INDEX IF NOT EXISTS "distribution_logs_departmentId_idx"
  ON "distribution_logs" ("departmentId");

CREATE INDEX IF NOT EXISTS "scheduled_whatsapp_calls_contactId_idx"
  ON "scheduled_whatsapp_calls" ("contactId");

CREATE INDEX IF NOT EXISTS "calls_contact_id_idx"
  ON "calls" ("contact_id");

-- ── Campanha: claim O(lote) + listOrgsWithPending sem varrer a tabela

CREATE INDEX IF NOT EXISTS "campaign_recipients_org_status_id_idx"
  ON "campaign_recipients" ("organizationId", "status", "id");

CREATE INDEX IF NOT EXISTS "campaign_recipients_pending_org_idx"
  ON "campaign_recipients" ("organizationId")
  WHERE status = 'PENDING';

-- ── Busca ILIKE / telefone (o schema Prisma não expressa GIN/ops)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "deals_title_trgm_idx"
  ON "deals" USING GIN ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "contacts_name_trgm_idx"
  ON "contacts" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "contacts_email_trgm_idx"
  ON "contacts" USING GIN ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "contacts_phone_trgm_idx"
  ON "contacts" USING GIN ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "dcfv_value_trgm_idx"
  ON "deal_custom_field_values" USING GIN ("value" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ccfv_value_trgm_idx"
  ON "contact_custom_field_values" USING GIN ("value" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "deal_cfv_value_digits_trgm_idx"
  ON "deal_custom_field_values"
  USING GIN ((regexp_replace(value, '\D', '', 'g')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "contact_cfv_value_digits_trgm_idx"
  ON "contact_custom_field_values"
  USING GIN ((regexp_replace(value, '\D', '', 'g')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "conversations_inbox_name_trgm_idx"
  ON "conversations" USING GIN ("inboxName" gin_trgm_ops)
  WHERE "inboxName" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "contacts_whatsapp_username_trgm_idx"
  ON "contacts" USING GIN ("whatsapp_username" gin_trgm_ops)
  WHERE "whatsapp_username" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "contacts_source_trgm_idx"
  ON "contacts" USING GIN ("source" gin_trgm_ops)
  WHERE "source" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "contacts_org_phone_digits_rev_pattern_idx"
  ON "contacts" USING btree (
    "organizationId",
    (reverse(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'))) text_pattern_ops
  );
