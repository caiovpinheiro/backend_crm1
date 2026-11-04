-- Regras de horário por departamento do modo "leads" (Distribuição por Leads).
-- Só o motor leads lê esta tabela, e só com a setting
-- `distribution.leads.departmentRules.enabled` ligada (padrão desligado):
-- nenhuma org muda de comportamento ao aplicar esta migration.
CREATE TABLE IF NOT EXISTS "distribution_leads_department_rules" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "departmentId"   TEXT NOT NULL,
  "startMinute"    INTEGER NOT NULL,
  "endMinute"      INTEGER NOT NULL,
  "weekdays"       INTEGER[] NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "distribution_leads_department_rules_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_department_rules_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_department_rules_minutes_check"
    CHECK (
      "startMinute" BETWEEN 0 AND 1439
      AND "endMinute" BETWEEN 0 AND 1439
      AND "startMinute" <> "endMinute"
    )
);

CREATE INDEX IF NOT EXISTS "distribution_leads_department_rules_organizationId_departmentId_idx"
  ON "distribution_leads_department_rules" ("organizationId", "departmentId");
