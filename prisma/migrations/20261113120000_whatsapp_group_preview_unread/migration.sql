-- Grupos WhatsApp: prévia da última mensagem e contador de não lidas.
-- Campos fixos por grupo, sobrescritos a cada mensagem (não acumulam).
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "lastMessagePreview" TEXT;
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "lastMessageAuthor" TEXT;
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "lastMessageFromMe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "lastReadAt" TIMESTAMP(3);

-- O que já existe conta como visto: o contador começa zerado no deploy.
UPDATE "whatsapp_groups" SET "lastReadAt" = NOW() WHERE "lastReadAt" IS NULL;

-- Prévia da última mensagem de cada grupo que já tem histórico.
UPDATE "whatsapp_groups" g
SET "lastMessagePreview" = LEFT(REGEXP_REPLACE(
      CASE m."messageType"
        WHEN 'ptt' THEN '🎤 Áudio'
        WHEN 'audio' THEN '🎤 Áudio'
        WHEN 'image' THEN '📷 Foto'
        WHEN 'video' THEN '🎥 Vídeo'
        WHEN 'sticker' THEN 'Figurinha'
        WHEN 'document' THEN '📎 ' || COALESCE(m."fileName", 'Arquivo')
        ELSE m."text"
      END, '\s+', ' ', 'g'), 120),
    "lastMessageAuthor" = CASE WHEN m."fromMe" THEN NULL ELSE COALESCE(m."fromName", m."fromPhone") END,
    "lastMessageFromMe" = m."fromMe"
FROM (
  SELECT DISTINCT ON ("groupId") "groupId", "messageType", "text", "fileName", "fromMe", "fromName", "fromPhone"
  FROM "whatsapp_group_messages"
  ORDER BY "groupId", "createdAt" DESC
) m
WHERE m."groupId" = g."id";
