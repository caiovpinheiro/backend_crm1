-- Add draft config and version history to AI agent v2.

BEGIN;

ALTER TABLE "ai_agent_configs"
  ADD COLUMN "draft_config" JSONB;

CREATE TABLE "ai_agent_config_versions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "version_number" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "comment" TEXT,
  "created_by_id" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("agentId", "version_number")
);

CREATE INDEX idx_aiconfigversions_org ON "ai_agent_config_versions"("organizationId");
CREATE INDEX idx_aiconfigversions_agent_created ON "ai_agent_config_versions"("agentId", "createdAt");

COMMIT;
