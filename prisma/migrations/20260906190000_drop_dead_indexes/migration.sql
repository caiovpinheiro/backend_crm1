-- Drop de índices mortos / duplicados.
--
-- Base: pg_stat_user_indexes de produção (uptime 12 dias, virada de mês
-- 31/ago dentro da janela) — todos com idx_scan = 0, e verificados contra
-- o código: nenhuma query os alcança.
--
-- DROP INDEX é metadata-only (rápido); IF EXISTS torna idempotente para
-- ambientes onde o índice foi removido manualmente em prod.

-- meta_webhook_events: a tabela só é lida por `id` (findUnique). phoneNumberId
-- e waMessageId nunca são filtrados. ~177 MB de índice em tabela com ~29k
-- inserts/dia.
DROP INDEX IF EXISTS "meta_webhook_events_phoneNumberId_receivedAt_idx";
DROP INDEX IF EXISTS "meta_webhook_events_waMessageId_idx";

-- contacts: duplicata snake_case de contacts_organizationId_number_idx (que
-- por sua vez é redundante com o unique key organizationId_number, mas isso
-- fica para outro passo). Criada em 20260612000000_contact_sequential_number.
DROP INDEX IF EXISTS "contacts_organization_id_number_idx";

-- contacts: órfãos sem escopo de org — a app sempre filtra por organizationId,
-- então btree só em (coluna) nunca é escolhido pelo planner.
DROP INDEX IF EXISTS "contacts_updatedAt_idx";
DROP INDEX IF EXISTS "contacts_lifecycleStage_createdAt_idx";

-- deals: duplicata exata de deals_organizationId_updatedAt_idx
-- (20260828220000_deal_org_updated_at_idx). Criada em
-- 20260519110000_kanban_filter_indexes, 3 meses antes.
DROP INDEX IF EXISTS "deals_org_updatedAt_idx";

-- messages: índice parcial que dava suporte ao stale-outbound-sweeper, que
-- está DESATIVADO no código (src/services/stale-outbound-sweeper.ts). Se o
-- sweeper voltar, o índice volta junto.
DROP INDEX IF EXISTS "messages_stale_outbound_idx";
