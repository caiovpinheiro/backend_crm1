-- Grupos WhatsApp: reações e resposta citada nas mensagens.
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "reactions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "replyToWaId" TEXT;
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "replyToText" TEXT;
ALTER TABLE "whatsapp_group_messages" ADD COLUMN IF NOT EXISTS "replyToAuthor" TEXT;
-- Achar a mensagem pelo id do WhatsApp (reação e resposta que chegam do grupo).
CREATE INDEX IF NOT EXISTS "whatsapp_group_messages_groupId_waMessageId_idx"
  ON "whatsapp_group_messages"("groupId", "waMessageId");
