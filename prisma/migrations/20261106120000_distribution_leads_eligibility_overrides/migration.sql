-- Liberação/pausa manual e temporária de consultor no modo leads.
-- Só cria a tabela: nenhum consultor muda de situação ao aplicar.
CREATE TABLE IF NOT EXISTS "distribution_leads_eligibility_overrides" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "eligible"       BOOLEAN NOT NULL,
  "startsAt"       TIMESTAMP(3) NOT NULL,
  "endsAt"         TIMESTAMP(3) NOT NULL,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "distribution_leads_eligibility_overrides_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_eligibility_overrides_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_eligibility_overrides_window_check"
    CHECK ("endsAt" > "startsAt")
);

CREATE INDEX IF NOT EXISTS "distribution_leads_eligibility_overrides_organizationId_endsAt_idx"
  ON "distribution_leads_eligibility_overrides" ("organizationId", "endsAt");
CREATE INDEX IF NOT EXISTS "distribution_leads_eligibility_overrides_organizationId_userId_idx"
  ON "distribution_leads_eligibility_overrides" ("organizationId", "userId");
