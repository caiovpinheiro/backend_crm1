-- Board ordenado por "Última interação" (loadBoardStagesByLastInteraction):
-- a agregação `MAX(conversations."updatedAt")` por contato fazia heap fetch
-- por linha porque (organizationId, contactId) não cobre `updatedAt`.
--
-- Substitui o índice de 2 colunas pelo de 3 — mesma contagem de índices na
-- tabela (conversations já tem 18), cobertura estritamente maior: todo
-- lookup por (org, contact) que o antigo servia + agora index-only para o
-- MAX(updatedAt).
--
-- PRODUÇÃO (tabela ~590 MB): o `CREATE INDEX` abaixo trava escrita em
-- `conversations` por alguns segundos. Se preferir zero downtime, rode ANTES
-- do deploy, fora de transação:
--   CREATE INDEX CONCURRENTLY "conversations_organizationId_contactId_updatedAt_idx"
--     ON "conversations" ("organizationId", "contactId", "updatedAt");
-- e o IF NOT EXISTS aqui vira no-op.

CREATE INDEX IF NOT EXISTS "conversations_organizationId_contactId_updatedAt_idx"
  ON "conversations" ("organizationId", "contactId", "updatedAt");

DROP INDEX IF EXISTS "conversations_organizationId_contactId_idx";
