-- Webchat: vínculo por campo de negócio e atendimento de quem chega identificado
-- (docs/decisoes/webchat-widget.md §9.12).
--
-- Só aditiva. Quatro partes:
--
-- 1. conversations."priorityAt" e "routedAt": colunas nullable sem default
--    (ADD COLUMN é só catálogo no PG 17, instantâneo).
-- 2. conversations_active_priority_idx: parcial, contém SÓ as conversas
--    prioritárias ativas. A consulta do topo do inbox lê este índice; a query
--    principal da lista não muda. Organização sem prioridade tem índice vazio.
--    O predicado usa as mesmas colunas que encerram a prioridade: encerrar ou a
--    primeira resposta humana tiram a linha do índice sem gancho em código.
-- 3. deal_custom_field_values_field_value_idx: busca por (campo, valor).
--    É parcial por tamanho: "value" é texto sem limite, e um btree direto faria
--    a gravação de um valor longo falhar em qualquer organização. O identificador
--    do site tem no máximo 128 caracteres.
-- 4. webchat_identity_links: tabela nova.
--
-- PRODUÇÃO: conversations tem ~590 MB e deal_custom_field_values também é grande.
-- O CREATE INDEX abaixo bloqueia escrita enquanto constrói. ANTES do deploy (o
-- boot da API roda migrate deploy), rode à mão, fora de transação, uma linha por vez:
--
--   ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "priorityAt" TIMESTAMP(3);
--   ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "routedAt" TIMESTAMP(3);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_active_priority_idx"
--     ON "conversations" ("organizationId", "priorityAt", "id")
--     WHERE "priorityAt" IS NOT NULL AND "status" = 'OPEN' AND "hasHumanReply" = false;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "deal_custom_field_values_field_value_idx"
--     ON "deal_custom_field_values" ("customFieldId", "value")
--     WHERE length("value") <= 128;
--
-- e confira que ficaram válidos (um CONCURRENTLY interrompido deixa o índice
-- INVALID; nesse caso DROP INDEX CONCURRENTLY e crie de novo):
--
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('conversations_active_priority_idx', 'deal_custom_field_values_field_value_idx');
--
-- Com isso os IF NOT EXISTS daqui viram no-op.
--
-- Rollback (o código anterior não lê nada disto):
--   DROP INDEX CONCURRENTLY IF EXISTS "conversations_active_priority_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "deal_custom_field_values_field_value_idx";
--   DROP TABLE IF EXISTS "webchat_identity_links";
-- As colunas podem ficar.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "priorityAt" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "routedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "conversations_active_priority_idx"
  ON "conversations" ("organizationId", "priorityAt", "id")
  WHERE "priorityAt" IS NOT NULL AND "status" = 'OPEN' AND "hasHumanReply" = false;

CREATE INDEX IF NOT EXISTS "deal_custom_field_values_field_value_idx"
  ON "deal_custom_field_values" ("customFieldId", "value")
  WHERE length("value") <= 128;

CREATE TABLE IF NOT EXISTS "webchat_identity_links" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "dealId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webchat_identity_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "webchat_identity_links_channelId_value_key"
  ON "webchat_identity_links" ("channelId", "value");
CREATE UNIQUE INDEX IF NOT EXISTS "webchat_identity_links_channelId_contactId_key"
  ON "webchat_identity_links" ("channelId", "contactId");
CREATE INDEX IF NOT EXISTS "webchat_identity_links_organizationId_idx"
  ON "webchat_identity_links" ("organizationId");
CREATE INDEX IF NOT EXISTS "webchat_identity_links_contactId_idx"
  ON "webchat_identity_links" ("contactId");
CREATE INDEX IF NOT EXISTS "webchat_identity_links_dealId_idx"
  ON "webchat_identity_links" ("dealId");

DO $$ BEGIN
  ALTER TABLE "webchat_identity_links" ADD CONSTRAINT "webchat_identity_links_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "webchat_identity_links" ADD CONSTRAINT "webchat_identity_links_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "webchat_identity_links" ADD CONSTRAINT "webchat_identity_links_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "webchat_identity_links" ADD CONSTRAINT "webchat_identity_links_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
