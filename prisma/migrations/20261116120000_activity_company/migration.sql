-- Tarefa vinculada a uma empresa (/companies). Opcional; apagar a empresa
-- só desvincula a tarefa.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

CREATE INDEX IF NOT EXISTS "activities_organizationId_companyId_idx"
ON "activities"("organizationId", "companyId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activities_companyId_fkey') THEN
    ALTER TABLE "activities"
    ADD CONSTRAINT "activities_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
