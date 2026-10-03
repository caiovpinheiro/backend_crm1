-- Caminho da retenção de meta_webhook_events (C3 / 0.6 da 2ª rodada da
-- auditoria). NÃO liga a retenção — só deixa os dois índices de que ela
-- depende. Agendar o cron `/api/cron/db-retention` continua dependendo de
-- aprovação (item 1.10).
--
-- Por que a retenção travaria sem isto:
--
-- 1) FK sem índice. automation_logs."metaWebhookEventId" referencia
--    meta_webhook_events(id) com ON DELETE SET NULL. Para cada linha apagada
--    em meta_webhook_events o Postgres roda
--      UPDATE automation_logs SET "metaWebhookEventId" = NULL
--       WHERE "metaWebhookEventId" = $1
--    e, sem índice na coluna, isso é um seq scan de automation_logs
--    (~850 MB / 1,4 M linhas em produção) POR LINHA apagada. Um lote de 5 mil
--    = 5 mil varreduras; estoura o statement_timeout de 30 s no 1º lote.
--    O índice antigo foi removido em 20260906210000 / 20260911220000 por ter
--    0 scans (a consulta nunca filtra pela coluna; só a FK precisa dele).
--    Agora é PARCIAL (IS NOT NULL): a igualdade do gatilho de FK implica
--    NOT NULL, então o planner usa o parcial, e os logs sem evento Meta
--    ficam fora do índice. Fica fora do schema.prisma (Prisma não expressa
--    índice parcial), como os demais índices de expressão/parciais.
--
-- 2) Nenhum índice por "receivedAt". Os existentes são
--    ("organizationId", "receivedAt" DESC) e (processed, "receivedAt"): nenhum
--    tem "receivedAt" como 1ª coluna, então o `count(*) ... WHERE
--    "receivedAt" < $1` e o `SELECT ctid ... WHERE "receivedAt" < $1 LIMIT
--    5000` de src/services/db-retention.ts varrem a tabela inteira (~3,3 GB).
--    Btree e não BRIN: a retenção apaga sempre a ponta antiga e as novas
--    linhas reusam o espaço liberado; o resumo de um bloco BRIN só alarga
--    (não encolhe com DELETE), então depois de uma volta da tabela todos os
--    blocos "contêm" datas antigas e o BRIN deixa de filtrar. Btree mantém o
--    custo proporcional ao que é apagado. Este está no schema
--    (@@index([receivedAt])) com o nome padrão do Prisma.
--
-- PRODUÇÃO (tabelas grandes): os `CREATE INDEX` abaixo travam escrita na
-- tabela enquanto constroem — e meta_webhook_events recebe todo webhook da
-- Meta. Rode ANTES do deploy, fora de transação, um de cada vez:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_logs_metaWebhookEventId_nn_idx"
--     ON "automation_logs" ("metaWebhookEventId")
--     WHERE "metaWebhookEventId" IS NOT NULL;
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_webhook_events_receivedAt_idx"
--     ON "meta_webhook_events" ("receivedAt");
--
-- Conferir que ficaram válidos (CONCURRENTLY que falha deixa índice
-- INVALID com o nome ocupado — aí DROP INDEX CONCURRENTLY e rodar de novo):
--
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('automation_logs_metaWebhookEventId_nn_idx',
--                        'meta_webhook_events_receivedAt_idx');
--
-- Com os dois presentes, este arquivo não faz nada: cada bloco só consulta o
-- catálogo e sai, sem pegar lock nas tabelas. (CONCURRENTLY não roda dentro
-- da transação do `migrate deploy`, por isso não está no arquivo.)
--
-- Antes do primeiro lote de verdade: rodar a retenção em dry-run
-- (`apply=false`, só conta) e um lote pequeno manual com
-- EXPLAIN (ANALYZE, BUFFERS) para conferir que o DELETE usa
-- meta_webhook_events_receivedAt_idx e o gatilho da FK não seq-scaneia.
--
-- Rollback:
--   DROP INDEX IF EXISTS "automation_logs_metaWebhookEventId_nn_idx";
--   DROP INDEX IF EXISTS "meta_webhook_events_receivedAt_idx";
-- (nada lê esses índices fora da retenção.)

DO $$
BEGIN
  IF to_regclass('"automation_logs_metaWebhookEventId_nn_idx"') IS NULL THEN
    CREATE INDEX "automation_logs_metaWebhookEventId_nn_idx"
      ON "automation_logs" ("metaWebhookEventId")
      WHERE "metaWebhookEventId" IS NOT NULL;
  END IF;

  IF to_regclass('"meta_webhook_events_receivedAt_idx"') IS NULL THEN
    CREATE INDEX "meta_webhook_events_receivedAt_idx"
      ON "meta_webhook_events" ("receivedAt");
  END IF;
END$$;
