-- Distribuicao por Leads (modo "leads") — tabelas novas + colunas de rota/origem.
--
-- - Department.distributionMode: "smart" (default, comportamento atual) ou
--   "leads" (departamento fica fora da distribuicao/fila smart; a distribuicao
--   acontece via bloco execute_distribution com mode="leads").
-- - Conversation.routeMode: rota destinada ("leads"); conversa marcada fica
--   fora da fila derivada e da distribuicao automatica smart ate atribuicao
--   explicita. Sem TTL.
-- - Conversation.assignedVia / Deal.assignedVia: origem da atribuicao vigente
--   ("smart" | "leads"; null = manual/IA/legado). "leads" protege o dono de
--   reavaliacoes automaticas (offline/expediente).
-- - 4 tabelas do modo leads: participants (status administrativo proprio +
--   peso 0..5), slots (5 por participante; frequencia, nunca capacidade),
--   assignments (historico oficial — so grava na tx vencedora do claim) e
--   executions (resultado do step por occurrence — idempotencia de retries).
--
-- Tudo aditivo com defaults: nenhum backfill, nenhuma dedupe, nenhum dado
-- existente muda de comportamento.
-- RLS no mesmo padrao canonico (organization_widgets / distribution_*):
-- policies criadas, RLS deixada DESABILITADA (isolamento ativo via Prisma
-- Extension + getOrgIdOrThrow).
--
-- migration-safety: ignore (tabelas novas + colunas nullable/default; nao altera dados existentes).

ALTER TABLE "departments"
  ADD COLUMN IF NOT EXISTS "distributionMode" TEXT NOT NULL DEFAULT 'smart';

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "routeMode" TEXT,
  ADD COLUMN IF NOT EXISTS "assignedVia" TEXT;

ALTER TABLE "deals"
  ADD COLUMN IF NOT EXISTS "assignedVia" TEXT;

CREATE INDEX IF NOT EXISTS "conversations_org_routemode_idx"
  ON "conversations" ("organizationId")
  WHERE "routeMode" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "distribution_leads_participants" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "weight"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "distribution_leads_participants_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_participants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_participants_weight_check"
    CHECK ("weight" BETWEEN 0 AND 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS "distribution_leads_participants_organizationId_userId_key"
  ON "distribution_leads_participants" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "distribution_leads_participants_organizationId_status_idx"
  ON "distribution_leads_participants" ("organizationId", "status");

CREATE TABLE IF NOT EXISTS "distribution_leads_slots" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "participantId"  TEXT NOT NULL,
  "slotIndex"      INTEGER NOT NULL,
  "lastAssignedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "distribution_leads_slots_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_slots_participantId_fkey"
    FOREIGN KEY ("participantId") REFERENCES "distribution_leads_participants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_slots_slotindex_check"
    CHECK ("slotIndex" BETWEEN 0 AND 4)
);

CREATE UNIQUE INDEX IF NOT EXISTS "distribution_leads_slots_participantId_slotIndex_key"
  ON "distribution_leads_slots" ("participantId", "slotIndex");
CREATE INDEX IF NOT EXISTS "distribution_leads_slots_organizationId_lastAssignedAt_idx"
  ON "distribution_leads_slots" ("organizationId", "lastAssignedAt");

CREATE TABLE IF NOT EXISTS "distribution_leads_assignments" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "participantId"  TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "slotIndex"      INTEGER NOT NULL,
  "targetKey"      TEXT NOT NULL,
  "contactId"      TEXT,
  "dealId"         TEXT,
  "conversationId" TEXT,
  "triggerSource"  TEXT NOT NULL DEFAULT 'AUTOMATION',
  "executionKey"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "distribution_leads_assignments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "distribution_leads_assignments_participantId_fkey"
    FOREIGN KEY ("participantId") REFERENCES "distribution_leads_participants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "distribution_leads_assignments_organizationId_executionKey_key"
  ON "distribution_leads_assignments" ("organizationId", "executionKey");
CREATE INDEX IF NOT EXISTS "distribution_leads_assignments_organizationId_createdAt_idx"
  ON "distribution_leads_assignments" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "distribution_leads_assignments_organizationId_userId_createdAt_idx"
  ON "distribution_leads_assignments" ("organizationId", "userId", "createdAt");
CREATE INDEX IF NOT EXISTS "distribution_leads_assignments_organizationId_targetKey_idx"
  ON "distribution_leads_assignments" ("organizationId", "targetKey");

CREATE TABLE IF NOT EXISTS "distribution_leads_executions" (
  "id"                  TEXT PRIMARY KEY,
  "organizationId"      TEXT NOT NULL,
  "automationContextId" TEXT NOT NULL,
  "stepId"              TEXT NOT NULL,
  "occurrence"          INTEGER NOT NULL,
  "result"              JSONB NOT NULL,
  "assignmentId"        TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "distribution_leads_executions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "distribution_leads_executions_context_step_occurrence_key"
  ON "distribution_leads_executions" ("automationContextId", "stepId", "occurrence");
CREATE INDEX IF NOT EXISTS "distribution_leads_executions_organizationId_createdAt_idx"
  ON "distribution_leads_executions" ("organizationId", "createdAt");

-- Policies RLS no padrao canonico (RLS permanece DESABILITADA).
DROP POLICY IF EXISTS tenant_isolation ON "distribution_leads_participants";
DROP POLICY IF EXISTS super_admin_bypass ON "distribution_leads_participants";
CREATE POLICY tenant_isolation ON "distribution_leads_participants"
USING ("organizationId" = current_organization_id())
WITH CHECK ("organizationId" = current_organization_id());
CREATE POLICY super_admin_bypass ON "distribution_leads_participants"
USING (current_is_super_admin())
WITH CHECK (current_is_super_admin());

DROP POLICY IF EXISTS tenant_isolation ON "distribution_leads_slots";
DROP POLICY IF EXISTS super_admin_bypass ON "distribution_leads_slots";
CREATE POLICY tenant_isolation ON "distribution_leads_slots"
USING ("organizationId" = current_organization_id())
WITH CHECK ("organizationId" = current_organization_id());
CREATE POLICY super_admin_bypass ON "distribution_leads_slots"
USING (current_is_super_admin())
WITH CHECK (current_is_super_admin());

DROP POLICY IF EXISTS tenant_isolation ON "distribution_leads_assignments";
DROP POLICY IF EXISTS super_admin_bypass ON "distribution_leads_assignments";
CREATE POLICY tenant_isolation ON "distribution_leads_assignments"
USING ("organizationId" = current_organization_id())
WITH CHECK ("organizationId" = current_organization_id());
CREATE POLICY super_admin_bypass ON "distribution_leads_assignments"
USING (current_is_super_admin())
WITH CHECK (current_is_super_admin());

DROP POLICY IF EXISTS tenant_isolation ON "distribution_leads_executions";
DROP POLICY IF EXISTS super_admin_bypass ON "distribution_leads_executions";
CREATE POLICY tenant_isolation ON "distribution_leads_executions"
USING ("organizationId" = current_organization_id())
WITH CHECK ("organizationId" = current_organization_id());
CREATE POLICY super_admin_bypass ON "distribution_leads_executions"
USING (current_is_super_admin())
WITH CHECK (current_is_super_admin());
