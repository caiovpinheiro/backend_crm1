-- Cron distributeStuckInbound (src/services/ai/stuck-inbound-distribution.ts):
-- varre conversas por janela de `lastInboundAt` (< cutoff AND >= since).
-- Sem índice em `lastInboundAt` a query custava ~30 ms/call (4,2% do tempo
-- total do banco em prod).
--
-- Parcial: a maioria das conversas nunca teve inbound (campanha, etc.), então
-- o índice fica pequeno e o custo de escrita some para essas linhas. Prisma
-- não declara índice parcial no schema — fica só como SQL.

CREATE INDEX IF NOT EXISTS "conversations_lastInboundAt_partial_idx"
  ON "conversations" ("lastInboundAt")
  WHERE "lastInboundAt" IS NOT NULL;
