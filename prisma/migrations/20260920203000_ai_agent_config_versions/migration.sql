-- Add draft config and version history to AI agent v2.

BEGIN;

ALTER TABLE "ai_agent_configs"
  ADD COLUMN IF NOT EXISTS "draft_config" JSONB;

CREATE TABLE IF NOT EXISTS "ai_agent_config_versions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "comment" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("agentId", "versionNumber")
);

CREATE INDEX IF NOT EXISTS idx_aiconfigversions_org ON "ai_agent_config_versions"("organizationId");
CREATE INDEX IF NOT EXISTS idx_aiconfigversions_agent_created ON "ai_agent_config_versions"("agentId", "createdAt");

COMMIT;
