-- Busca de produtos sem acento com índice (B6 / auditoria R3-BD-1).
--
-- Produção (05/10): `GET /api/products?search=` fazia
--   translate(lower(p.name), $a, $b) LIKE $x OR translate(lower(coalesce(p.sku,'')), $a, $b) LIKE $x
-- e um COUNT(*) com o mesmo WHERE — ~25 ms cada, 24% do tempo de banco. Os
-- únicos índices de `products` são btree em ("organizationId", ...), que não
-- servem para '%termo%', e as constantes de acento iam como PARÂMETROS
-- ($a, $b), o que impede casar com qualquer índice de expressão.
--
-- Agora:
--   1) `public.crm_fold(text)`: lower + troca de acentos, IMMUTABLE. A consulta
--      (src/app/api/products/route.ts) usa EXATAMENTE `public.crm_fold(p.name)`
--      e `public.crm_fold(p.sku)`, sem parâmetro dentro da expressão — o teste
--      `src/app/api/products/route.test.ts` compara o SQL enviado com as
--      expressões dos índices abaixo. Mudar a função ou a expressão de um lado
--      sem o outro desliga o índice.
--   2) índices GIN trigram sobre a mesma expressão (nome; SKU parcial, só
--      quem tem SKU — a consulta repete `p.sku IS NOT NULL`).
--   3) total pela janela (`count(*) OVER ()`) na mesma ida, sem COUNT separado;
--      termo com menos de 2 letras não filtra (trigrama precisa de 3).
--
-- PRODUÇÃO: os `CREATE INDEX` abaixo travam escrita em `products` enquanto
-- constroem. Rode ANTES do deploy, fora de transação, nesta ordem:
--
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--
--   CREATE OR REPLACE FUNCTION public.crm_fold(text) RETURNS text
--     LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
--     AS $fn$ SELECT translate(lower($1), 'áàâãäåéèêëíìîïóòôõöúùûüýÿçñ', 'aaaaaaeeeeiiiiooooouuuuyycn') $fn$;
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_name_fold_trgm_idx"
--     ON "products" USING GIN (public.crm_fold("name") gin_trgm_ops);
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_sku_fold_trgm_idx"
--     ON "products" USING GIN (public.crm_fold("sku") gin_trgm_ops)
--     WHERE "sku" IS NOT NULL;
--
-- Conferir que ficaram válidos (CONCURRENTLY que falha deixa índice INVALID
-- com o nome ocupado — aí DROP INDEX CONCURRENTLY e rodar de novo):
--
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('products_name_fold_trgm_idx', 'products_sku_fold_trgm_idx');
--
-- Depois do deploy, o plano esperado é Bitmap Index Scan nesses índices:
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT p.id FROM products p
--    WHERE p."organizationId" = '<org>' AND public.crm_fold(p.name) LIKE '%adm%';
--
-- Com a função e os dois índices já presentes, este arquivo não faz nada que
-- trave a tabela: `CREATE OR REPLACE` com o mesmo corpo e os blocos que só
-- consultam o catálogo. (CONCURRENTLY não roda dentro da transação do
-- `migrate deploy`, por isso não está no corpo.)
--
-- Rollback (só depois de voltar o código da rota):
--   DROP INDEX CONCURRENTLY IF EXISTS "products_name_fold_trgm_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "products_sku_fold_trgm_idx";
--   DROP FUNCTION IF EXISTS public.crm_fold(text);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.crm_fold(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $fn$ SELECT translate(lower($1), 'áàâãäåéèêëíìîïóòôõöúùûüýÿçñ', 'aaaaaaeeeeiiiiooooouuuuyycn') $fn$;

DO $$
BEGIN
  IF to_regclass('"products_name_fold_trgm_idx"') IS NULL THEN
    CREATE INDEX "products_name_fold_trgm_idx"
      ON "products" USING GIN (public.crm_fold("name") gin_trgm_ops);
  END IF;

  IF to_regclass('"products_sku_fold_trgm_idx"') IS NULL THEN
    CREATE INDEX "products_sku_fold_trgm_idx"
      ON "products" USING GIN (public.crm_fold("sku") gin_trgm_ops)
      WHERE "sku" IS NOT NULL;
  END IF;
END$$;
