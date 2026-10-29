-- Webchat v2 — base compartilhada (docs/decisoes/webchat-widget.md §9).
--
-- Só ADITIVA: uma coluna anulável em webchat_sessions (ALTER instantâneo,
-- sem default, sem reescrever a tabela) e quatro tabelas NOVAS. Todos os
-- índices são de tabelas novas (vazias no deploy) — nenhum índice em tabela
-- grande existente, então nada de CREATE INDEX CONCURRENTLY aqui. Idempotente
-- (IF NOT EXISTS / duplicate_object): reaplicar não falha.
--
-- LGPD: tudo que é do contato cai com ele (FK ON DELETE CASCADE em contactId
-- e sessionId); o merge de contatos reponta as linhas
-- (src/services/merge-contacts.ts → src/lib/webchat/visitor-data.ts).

-- AlterTable
ALTER TABLE "webchat_sessions" ADD COLUMN IF NOT EXISTS "identityVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "webchat_live_contexts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "contactId" TEXT,
    "sessionId" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webchat_live_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "webchat_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "contactId" TEXT,
    "sessionId" TEXT,
    "name" TEXT NOT NULL,
    "data" JSONB,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webchat_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "webchat_ingress_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "webchat_ingress_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "webchat_conversation_refs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT,
    "priority" TEXT,
    "lastCallbackStatus" TEXT,
    "lastCallbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webchat_conversation_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webchat_live_contexts_sessionId_key" ON "webchat_live_contexts"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_live_contexts_contactId_idx" ON "webchat_live_contexts"("contactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_live_contexts_organizationId_updatedAt_idx" ON "webchat_live_contexts"("organizationId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webchat_live_contexts_channelId_contactId_key" ON "webchat_live_contexts"("channelId", "contactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_events_contactId_occurredAt_idx" ON "webchat_events"("contactId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_events_contactId_name_occurredAt_idx" ON "webchat_events"("contactId", "name", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_events_sessionId_occurredAt_idx" ON "webchat_events"("sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_events_channelId_createdAt_idx" ON "webchat_events"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_ingress_keys_createdAt_idx" ON "webchat_ingress_keys"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webchat_ingress_keys_channelId_idempotencyKey_key" ON "webchat_ingress_keys"("channelId", "idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_conversation_refs_organizationId_ref_idx" ON "webchat_conversation_refs"("organizationId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webchat_conversation_refs_conversationId_ref_key" ON "webchat_conversation_refs"("conversationId", "ref");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_live_contexts" ADD CONSTRAINT "webchat_live_contexts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_live_contexts" ADD CONSTRAINT "webchat_live_contexts_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_live_contexts" ADD CONSTRAINT "webchat_live_contexts_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_live_contexts" ADD CONSTRAINT "webchat_live_contexts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "webchat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_events" ADD CONSTRAINT "webchat_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_events" ADD CONSTRAINT "webchat_events_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_events" ADD CONSTRAINT "webchat_events_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_events" ADD CONSTRAINT "webchat_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "webchat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_ingress_keys" ADD CONSTRAINT "webchat_ingress_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_ingress_keys" ADD CONSTRAINT "webchat_ingress_keys_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_conversation_refs" ADD CONSTRAINT "webchat_conversation_refs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_conversation_refs" ADD CONSTRAINT "webchat_conversation_refs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Contexto vivo: dono é o contato OU o visitante anônimo, nunca os dois.
DO $$ BEGIN
  ALTER TABLE "webchat_live_contexts" ADD CONSTRAINT "webchat_live_contexts_owner_check" CHECK (("contactId" IS NULL) <> ("sessionId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
