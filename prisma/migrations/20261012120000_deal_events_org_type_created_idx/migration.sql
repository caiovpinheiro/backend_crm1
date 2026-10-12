-- deal_events por (org, tipo, data) — seção `funnel` do Painel (aba Negócios).
--
-- `getPainelFunnel` (src/services/painel-deals.ts) lê `deal_events` filtrando
-- "organizationId" = $org AND type = 'STAGE_CHANGED' | 'CREATED' AND
-- "createdAt" no período, em três pontos: entradas (STAGE_CHANGED + CREATED),
-- saídas (STAGE_CHANGED) e entradas posteriores (passagem/perda). Até aqui só
-- existiam ("organizationId"), ("dealId", "createdAt") e ("userId"): o plano
-- lia todos os eventos da org e filtrava tipo/data depois.
--
-- PRODUÇÃO: o índice JÁ FOI CRIADO À MÃO, fora de transação:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "deal_events_org_type_created_idx"
--     ON "deal_events" ("organizationId", "type", "createdAt");
--
-- Em outro ambiente, rode esse comando ANTES do deploy (o entrypoint roda
-- `prisma migrate deploy` no boot e um `CREATE INDEX` comum trava escrita em
-- `deal_events` enquanto constrói). Conferir que ficou válido (CONCURRENTLY
-- que falha deixa índice INVALID com o nome ocupado — aí
-- DROP INDEX CONCURRENTLY e rodar de novo):
--
--   SELECT c.relname, i.indisvalid FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname = 'deal_events_org_type_created_idx';
--
-- Com o índice presente este arquivo só consulta o catálogo, sem lock na
-- tabela. (CONCURRENTLY não roda dentro da transação do `migrate deploy`.)
--
-- Rollback (o Painel continua correto sem ele, só volta a ler a org inteira):
--   DROP INDEX CONCURRENTLY IF EXISTS "deal_events_org_type_created_idx";

DO $$
BEGIN
  IF to_regclass('"deal_events_org_type_created_idx"') IS NULL THEN
    CREATE INDEX IF NOT EXISTS "deal_events_org_type_created_idx"
      ON "deal_events" ("organizationId", "type", "createdAt");
  END IF;
END$$;
