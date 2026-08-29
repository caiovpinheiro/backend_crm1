-- Canal por destinatário: campanha pode enviar no último canal conversado
-- de cada contato (`useLastConversationChannel`). Nesse modo `channelId`
-- fica null — o worker resolve o canal na hora do envio.

ALTER TABLE "campaigns"
  ADD COLUMN "useLastConversationChannel" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "campaigns"
  ALTER COLUMN "channelId" DROP NOT NULL;
