-- Grupos WhatsApp: ordem pela última mensagem e mídia como no inbox.
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "whatsapp_groups_channelId_lastMessageAt_idx"
  ON "whatsapp_groups"("channelId", "lastMessageAt");

ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "messageType" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "mediaUrl" TEXT;
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "mimeType" TEXT;
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "fileName" TEXT;

-- Grupos que já têm histórico entram na ordem certa desde o deploy.
UPDATE "whatsapp_groups" g
SET "lastMessageAt" = m."last"
FROM (
  SELECT "groupId", MAX("createdAt") AS "last"
  FROM "whatsapp_group_messages"
  GROUP BY "groupId"
) m
WHERE m."groupId" = g."id" AND g."lastMessageAt" IS NULL;
