-- O schema Prisma já tinha createdAt/updatedAt em membros e updatedAt em
-- mensagens de grupo. A migration original não criou essas colunas, e o
-- GET /api/whatsapp-groups/:id (include dos participantes) quebrava com 42703.

ALTER TABLE "whatsapp_group_members"
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "whatsapp_group_members"
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "whatsapp_group_messages"
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
