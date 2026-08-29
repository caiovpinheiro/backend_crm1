-- Canal por destinatário: campanha pode enviar no último canal conversado
-- de cada contato (`useLastConversationChannel`). Nesse modo `channelId`
-- fica null — o worker resolve o canal na hora do envio.
-- Idempotente: prod aplica via `db execute` (SKIP_PRISMA_MIGRATE=1).

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "useLastConversationChannel" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "campaigns"
  ALTER COLUMN "channelId" DROP NOT NULL;
