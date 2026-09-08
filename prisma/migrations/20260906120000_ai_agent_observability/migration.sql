-- Onda 0: observabilidade de runs + auditoria de config (nullable / additive).

ALTER TABLE "ai_agent_runs"
  ADD COLUMN IF NOT EXISTS "systemPromptSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "configHash" TEXT,
  ADD COLUMN IF NOT EXISTS "interceptsFired" JSONB,
  ADD COLUMN IF NOT EXISTS "llmInvoked" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "stepCountReached" BOOLEAN;

CREATE TABLE IF NOT EXISTS "ai_agent_config_audits" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "userId" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "diff" JSONB NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'api',
  CONSTRAINT "ai_agent_config_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_agent_config_audits_organizationId_idx"
  ON "ai_agent_config_audits"("organizationId");

CREATE INDEX IF NOT EXISTS "ai_agent_config_audits_agentId_changedAt_idx"
  ON "ai_agent_config_audits"("agentId", "changedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_config_audits_organizationId_fkey'
  ) THEN
    ALTER TABLE "ai_agent_config_audits"
      ADD CONSTRAINT "ai_agent_config_audits_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_config_audits_agentId_fkey'
  ) THEN
    ALTER TABLE "ai_agent_config_audits"
      ADD CONSTRAINT "ai_agent_config_audits_agentId_fkey"
      FOREIGN KEY ("agentId") REFERENCES "ai_agent_configs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
