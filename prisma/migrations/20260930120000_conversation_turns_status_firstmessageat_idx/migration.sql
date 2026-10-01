-- BD-12: o sweeper de turnos IA (`services/ai/turn-sweeper.ts`, passo 2)
-- consulta `status IN ('RECEIVING','STABILIZING') AND "firstMessageAt" <= $1
-- ORDER BY "firstMessageAt"`, mas só existia índice em (status, lastMessageAt).
-- Sem este índice cada tick (a cada 3 s, em 2+ processos) filtrava
-- `firstMessageAt` pós-scan.
--
-- PRODUÇÃO: a tabela é pequena (turnos terminais são poucos KB cada), mas se
-- preferir zero lock de escrita rode ANTES do deploy, fora de transação:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversation_turns_status_firstMessageAt_idx"
--     ON "conversation_turns" ("status", "firstMessageAt");
-- e o IF NOT EXISTS aqui vira no-op.

CREATE INDEX IF NOT EXISTS "conversation_turns_status_firstMessageAt_idx"
  ON "conversation_turns" ("status", "firstMessageAt");
