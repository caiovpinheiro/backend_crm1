-- Lista do inbox por cursor (P-14 / BD-6 da auditoria de banco).
--
-- A lista ordena por ("updatedAt", id) dentro da organização e a página
-- seguinte é `WHERE ("updatedAt", id) < (cursor) ORDER BY ... LIMIT n`.
-- O índice existente ("organizationId", status, "updatedAt") só entrega essa
-- ordem quando o filtro fixa `status` (filas OPEN). Em "Todos" (sem status)
-- e em Encerradas/Resolvendo (status num OR com "closedAt") o Postgres lia
-- e ordenava o escopo inteiro a cada página. Com este índice a leitura
-- começa no cursor e para no LIMIT.
--
-- É o mesmo índice que a subconsulta de representante por contato+canal de
-- Encerradas percorre na ordem (a irmã mais nova é procurada por
-- ("organizationId", "contactId", "updatedAt"), que já existe).
--
-- PRODUÇÃO (tabela ~590 MB): o `CREATE INDEX` abaixo trava escrita em
-- `conversations` enquanto constrói. Para zero bloqueio, rode ANTES do
-- deploy, fora de transação:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_organizationId_updatedAt_id_idx"
--     ON "conversations" ("organizationId", "updatedAt", "id");
-- e o IF NOT EXISTS aqui vira no-op. (CONCURRENTLY não roda dentro da
-- transação do `migrate deploy`, por isso não está no arquivo.)
--
-- Rollback: DROP INDEX IF EXISTS "conversations_organizationId_updatedAt_id_idx";
-- (a lista continua correta sem ele, só volta a ordenar o escopo).

CREATE INDEX IF NOT EXISTS "conversations_organizationId_updatedAt_id_idx"
  ON "conversations" ("organizationId", "updatedAt", "id");
