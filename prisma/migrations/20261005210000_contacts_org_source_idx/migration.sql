-- Origens distintas dos contatos por org (C2 da auditoria de banco, 05/10).
--
-- Produção (29/09 → 05/10): `GET /api/kanban/filter-options` rodou
--   SELECT DISTINCT source FROM contacts
--    WHERE "organizationId" = $1 AND source IS NOT NULL AND source <> '' LIMIT $2
-- 19.991 vezes a 55 ms (18 min de banco, 525.914 linhas devolvidas) e a
-- variante igual para ad_utm_source. Nenhum índice começa por
-- ("organizationId", source): o plano lia todos os contatos da org e
-- deduplicava. (`contacts_source_trgm_idx` é GIN trigram, serve só ao
-- ILIKE '%…%' da busca; `contacts_ad_utm_source_idx` não tem a org.)
--
-- A consulta nova (src/services/contact-source-options.ts) pula de valor em
-- valor pelo índice — um acesso por valor distinto — e o resultado fica em
-- cache por org (5–10 min). Ela DEPENDE destes dois índices: sem eles cada
-- passo da CTE recursiva ordena os contatos da org.
--
-- PRODUÇÃO: `CREATE INDEX` sem CONCURRENTLY trava escrita em `contacts`
-- enquanto constrói (180 mil linhas — segundos, mas o webhook grava contato
-- o tempo todo). Rode ANTES do deploy, fora de transação, um de cada vez:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_organizationId_source_idx"
--     ON "contacts" ("organizationId", "source");
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_organizationId_ad_utm_source_idx"
--     ON "contacts" ("organizationId", "ad_utm_source");
--
-- Conferir que ficaram válidos (CONCURRENTLY que falha deixa índice INVALID
-- com o nome ocupado — aí DROP INDEX CONCURRENTLY e rodar de novo):
--
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('contacts_organizationId_source_idx',
--                        'contacts_organizationId_ad_utm_source_idx');
--
-- Plano esperado depois do deploy (Index Only Scan / Index Scan com LIMIT 1
-- em cada passo, nenhum Sort):
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   WITH RECURSIVE t(v) AS (
--     (SELECT c."source" FROM contacts c
--       WHERE c."organizationId" = '<org>' AND c."source" > ''
--       ORDER BY c."source" LIMIT 1)
--     UNION ALL
--     SELECT (SELECT c."source" FROM contacts c
--              WHERE c."organizationId" = '<org>' AND c."source" > t.v
--              ORDER BY c."source" LIMIT 1)
--       FROM t WHERE t.v IS NOT NULL)
--   SELECT v FROM t WHERE v IS NOT NULL LIMIT 200;
--
-- Com os dois presentes este arquivo só consulta o catálogo. (CONCURRENTLY
-- não roda dentro da transação do `migrate deploy`.)
--
-- Rollback (só depois de voltar o código da rota):
--   DROP INDEX CONCURRENTLY IF EXISTS "contacts_organizationId_source_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "contacts_organizationId_ad_utm_source_idx";

DO $$
BEGIN
  IF to_regclass('"contacts_organizationId_source_idx"') IS NULL THEN
    CREATE INDEX "contacts_organizationId_source_idx"
      ON "contacts" ("organizationId", "source");
  END IF;

  IF to_regclass('"contacts_organizationId_ad_utm_source_idx"') IS NULL THEN
    CREATE INDEX "contacts_organizationId_ad_utm_source_idx"
      ON "contacts" ("organizationId", "ad_utm_source");
  END IF;
END$$;
