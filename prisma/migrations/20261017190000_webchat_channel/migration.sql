-- Webchat (docs/decisoes/webchat-widget.md, fase 0):
--   ChannelProvider.WEBCHAT, channels.publicKey, contacts.webchat_visitor_id
--   e a tabela webchat_sessions (tenant-scoped, sessão do visitante do widget).
--
-- Em produção, se `contacts` for grande, o operador pode criar o índice único
-- antes (fora de transação) para não segurar escrita no deploy — a migration
-- então só confere que ele existe:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "contacts_organizationId_webchat_visitor_id_key"
--     ON "contacts" ("organizationId", "webchat_visitor_id");
-- (a coluna precisa existir: ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "webchat_visitor_id" TEXT;)

-- AlterEnum (o valor não é usado nesta migration — seguro dentro da transação)
ALTER TYPE "ChannelProvider" ADD VALUE IF NOT EXISTS 'WEBCHAT';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "webchat_visitor_id" TEXT;

-- AlterTable
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "publicKey" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "webchat_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "contactId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "firstUrl" TEXT,
    "lastUrl" TEXT,
    "referrer" TEXT,
    "utm" JSONB,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webchat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webchat_sessions_tokenHash_key" ON "webchat_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_sessions_organizationId_channelId_lastSeenAt_idx" ON "webchat_sessions"("organizationId", "channelId", "lastSeenAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webchat_sessions_contactId_idx" ON "webchat_sessions"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_organizationId_webchat_visitor_id_key" ON "contacts"("organizationId", "webchat_visitor_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "channels_publicKey_key" ON "channels"("publicKey");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_sessions" ADD CONSTRAINT "webchat_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_sessions" ADD CONSTRAINT "webchat_sessions_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "webchat_sessions" ADD CONSTRAINT "webchat_sessions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
