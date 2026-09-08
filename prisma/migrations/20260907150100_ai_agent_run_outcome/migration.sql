-- Desfecho observado do run (item 6 da Fase 1).
-- `status` fica intacto para os consumidores existentes; `outcome` guarda o
-- que realmente aconteceu. Runs antigos ficam NULL (não reprocessamos).
DO $$
BEGIN
  CREATE TYPE "AIAgentRunOutcome" AS ENUM (
    'ANSWERED',
    'HANDOFF_COMPLETED',
    'HANDOFF_BLOCKED_BY_GATE',
    'TOOL_FAILED',
    'STEP_LIMIT_REACHED',
    'NO_CONTEXT'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ai_agent_runs"
  ADD COLUMN IF NOT EXISTS "outcome" "AIAgentRunOutcome";

CREATE INDEX IF NOT EXISTS "ai_agent_runs_outcome_idx"
  ON "ai_agent_runs" ("outcome");
