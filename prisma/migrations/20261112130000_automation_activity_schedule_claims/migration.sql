-- Claim durável do gatilho "horário da tarefa" (activity_scheduled): uma
-- execução por automação + tarefa + horário agendado.
CREATE TABLE IF NOT EXISTS "automation_activity_schedule_claims" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_activity_schedule_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "automation_activity_schedule_claim_uq"
ON "automation_activity_schedule_claims"("automationId", "activityId", "scheduledAt");

CREATE INDEX IF NOT EXISTS "automation_activity_schedule_org_created_idx"
ON "automation_activity_schedule_claims"("organizationId", "createdAt");

CREATE INDEX IF NOT EXISTS "automation_activity_schedule_activity_idx"
ON "automation_activity_schedule_claims"("activityId");

ALTER TABLE "automation_activity_schedule_claims"
ADD CONSTRAINT "automation_activity_schedule_org_fk"
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_activity_schedule_claims"
ADD CONSTRAINT "automation_activity_schedule_automation_fk"
FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_activity_schedule_claims"
ADD CONSTRAINT "automation_activity_schedule_activity_fk"
FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
