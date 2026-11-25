-- Agenda de envios automáticos do agente v2 (retomada agendada e follow-up
-- por etapa). Tabela nova, sem FK: nada existente é tocado nem travado.
CREATE TABLE IF NOT EXISTS "ai_v2_scheduled_sends" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sequenceId" TEXT,
    "stepIndex" INTEGER,
    "anchorMessageId" TEXT,
    "anchorAt" TIMESTAMP(3),
    "dealId" TEXT,
    "dealStageIdAtCreate" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "reason" TEXT,
    "resumeContext" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "sentVia" TEXT,
    "templateName" TEXT,
    "sentMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_v2_scheduled_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_v2_scheduled_sends_organizationId_idempotencyKey_key"
    ON "ai_v2_scheduled_sends"("organizationId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "ai_v2_scheduled_sends_status_dueAt_idx"
    ON "ai_v2_scheduled_sends"("status", "dueAt");
CREATE INDEX IF NOT EXISTS "ai_v2_scheduled_sends_conversationId_status_idx"
    ON "ai_v2_scheduled_sends"("conversationId", "status");
CREATE INDEX IF NOT EXISTS "ai_v2_scheduled_sends_agentId_createdAt_idx"
    ON "ai_v2_scheduled_sends"("agentId", "createdAt");

-- No máximo um envio aberto (PENDING/SENDING) por conversa e tipo: garantia
-- do banco contra duplicata, além da chave de idempotência. Parcial, fora do
-- schema.prisma (Prisma não descreve índice parcial).
CREATE UNIQUE INDEX IF NOT EXISTS "ai_v2_scheduled_sends_one_open_idx"
    ON "ai_v2_scheduled_sends"("conversationId", "kind")
    WHERE "status" IN ('PENDING', 'SENDING');
