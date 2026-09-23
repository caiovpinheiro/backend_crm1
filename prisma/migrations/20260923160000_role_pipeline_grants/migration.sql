-- Visibilidade de funil por papel. Sem linhas = o papel vê todos os funis.
-- Só persiste bloqueio (canView = false).

CREATE TABLE IF NOT EXISTS "role_pipeline_grants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "role_pipeline_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "role_pipeline_grants_roleId_pipelineId_key"
    ON "role_pipeline_grants"("roleId", "pipelineId");

CREATE INDEX IF NOT EXISTS "role_pipeline_grants_organizationId_idx"
    ON "role_pipeline_grants"("organizationId");

CREATE INDEX IF NOT EXISTS "role_pipeline_grants_roleId_idx"
    ON "role_pipeline_grants"("roleId");

DO $$ BEGIN
  ALTER TABLE "role_pipeline_grants"
    ADD CONSTRAINT "role_pipeline_grants_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
