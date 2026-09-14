-- Ticket ativo passa a ser 1 por (org, contato, plataforma, CONTA do canal).
-- Dois WhatsApps / duas páginas da mesma org não compartilham o ticket OPEN
-- — senão o inbound no número B reusa o ticket do A e não dispara
-- conversation_created (automações de boas-vindas / roteamento).
--
-- channelId NULL (legado): no máximo um OPEN por (org, contato, plataforma).

DROP INDEX IF EXISTS "conversations_active_contact_channel";

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_active_contact_channel_account"
ON "conversations" ("organizationId", "contactId", "channel", "channelId")
WHERE "status" <> 'RESOLVED' AND "channelId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_active_contact_channel_null"
ON "conversations" ("organizationId", "contactId", "channel")
WHERE "status" <> 'RESOLVED' AND "channelId" IS NULL;
