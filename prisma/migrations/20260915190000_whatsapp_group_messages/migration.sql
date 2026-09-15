-- Histórico de mensagens dos grupos WhatsApp QR. Não é Conversation do inbox.

CREATE TABLE "whatsapp_group_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "waMessageId" TEXT,
    "fromJid" TEXT NOT NULL,
    "fromName" TEXT,
    "fromPhone" TEXT,
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_group_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_group_messages_organizationId_idx" ON "whatsapp_group_messages"("organizationId");
CREATE INDEX "whatsapp_group_messages_groupId_createdAt_idx" ON "whatsapp_group_messages"("groupId", "createdAt");
CREATE INDEX "whatsapp_group_messages_groupId_waMessageId_idx" ON "whatsapp_group_messages"("groupId", "waMessageId");

ALTER TABLE "whatsapp_group_messages" ADD CONSTRAINT "whatsapp_group_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_group_messages" ADD CONSTRAINT "whatsapp_group_messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "whatsapp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
