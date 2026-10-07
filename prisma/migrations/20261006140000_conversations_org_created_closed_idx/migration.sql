-- Painel › Atendimentos › Equipe: leitura por período em `conversations`.
--
-- O mapa de calor departamento x hora, a carga do ranking e o TMA filtram
-- `conversations` por organização + intervalo de data. Os índices existentes
-- começam por (organizationId, status|updatedAt|contactId|assignedToId|...)
-- e nenhum cobre "createdAt" ou "closedAt": cada consulta lia a organização
-- inteira.
--
-- 1) ("organizationId", "createdAt") — conversas iniciadas no período
--    (mapa de calor, carga por atendente).
-- 2) ("organizationId", "closedAt") — conversas encerradas no período (TMA do
--    ranking e os "finalizados" do painel de atendimentos). O TMA filtrava por
--    COALESCE("closedAt", "updatedAt"), que nenhum índice cobre; agora filtra
--    por "closedAt" (encerrar sempre grava "closedAt"; reabrir zera).
--
-- PRODUÇÃO (tabela ~590 MB): o `CREATE INDEX` abaixo trava escrita em
-- `conversations` enquanto constrói. Para zero bloqueio, rode ANTES do
-- deploy (o entrypoint roda `prisma migrate deploy` no boot), um comando por
-- vez, fora de transação (Auto commit ligado):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_organizationId_createdAt_idx"
--     ON "conversations" ("organizationId", "createdAt");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_organizationId_closedAt_idx"
--     ON "conversations" ("organizationId", "closedAt");
-- e o IF NOT EXISTS daqui vira no-op. (CONCURRENTLY não roda dentro da
-- transação do `migrate deploy`, por isso não está no arquivo.)
--
-- Rollback:
--   DROP INDEX IF EXISTS "conversations_organizationId_createdAt_idx";
--   DROP INDEX IF EXISTS "conversations_organizationId_closedAt_idx";
-- (as telas continuam corretas sem eles, só voltam a ler a organização inteira).

CREATE INDEX IF NOT EXISTS "conversations_organizationId_createdAt_idx"
  ON "conversations" ("organizationId", "createdAt");

CREATE INDEX IF NOT EXISTS "conversations_organizationId_closedAt_idx"
  ON "conversations" ("organizationId", "closedAt");
