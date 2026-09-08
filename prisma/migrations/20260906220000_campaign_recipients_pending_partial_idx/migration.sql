-- campaign_recipients: o worker de campanha faz um "loose index scan" a cada
-- rodada do refill (listOrgsWithPending):
--
--   SELECT "organizationId" FROM campaign_recipients
--    WHERE status = 'PENDING' ORDER BY "organizationId" LIMIT 1  (+ keyset)
--
-- Sem índice liderando por `status`, quando NÃO há campanha rodando (estado
-- comum) isso varre a tabela à procura de um PENDING. pg_stat_statements:
-- 525k calls, 4,4% do tempo total do banco.
--
-- Índice parcial: só linhas PENDING (quase sempre ~0), então fica minúsculo
-- e o custo de escrita some assim que o recipient sai de PENDING.

CREATE INDEX IF NOT EXISTS "campaign_recipients_pending_org_idx"
  ON "campaign_recipients" ("organizationId")
  WHERE status = 'PENDING';
