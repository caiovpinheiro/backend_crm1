-- Busca do inbox: com o OR final reduzido a colunas de `conversations`
-- (contactId/assignedToId IN + inboxName + number), faltavam índices para
-- os dois ramos que ainda varriam tabela cheia.
--
-- `inboxName` é o mais importante: sendo um ramo do OR sobre a própria
-- `conversations`, sem índice ele obriga o planner a varrer a tabela inteira
-- e anula o ganho dos IN — que já têm
-- @@index([organizationId, contactId]) e ([organizationId, assignedToId]).
--
-- Todos parciais: as três colunas são nulas na maioria das linhas, então o
-- índice fica pequeno e o custo de escrita (contacts/conversations são
-- tabelas quentes) some para quem não usa o campo.
--
-- Versão CONCURRENTLY (produção, fora do prisma migrate) em
-- `prisma/scripts/create-trgm-indexes-concurrently.sql`.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "conversations_inbox_name_trgm_idx"
  ON "conversations" USING GIN ("inboxName" gin_trgm_ops)
  WHERE "inboxName" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "contacts_whatsapp_username_trgm_idx"
  ON "contacts" USING GIN ("whatsapp_username" gin_trgm_ops)
  WHERE "whatsapp_username" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "contacts_source_trgm_idx"
  ON "contacts" USING GIN ("source" gin_trgm_ops)
  WHERE "source" IS NOT NULL;
