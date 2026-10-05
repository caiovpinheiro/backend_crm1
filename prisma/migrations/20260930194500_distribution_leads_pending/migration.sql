-- Fila de espera da Distribuição por Leads.
-- Lead sem consultor elegível (ninguém ACTIVE com peso > 0) espera aqui
-- até a drenagem, disparada quando um participante fica elegível.
-- migration-safety: ignore (tabela nova; não altera dados existentes).

CREATE TABLE IF NOT EXISTS "distribution_leads_pending" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "contactId" TEXT,
    "dealId" TEXT,
    "conversationId" TEXT,
    "triggerSource" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_leads_pending_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "distribution_leads_pending_organizationId_status_createdAt_idx"
  ON "distribution_leads_pending"("organizationId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "distribution_leads_pending_organizationId_targetKey_status_idx"
  ON "distribution_leads_pending"("organizationId", "targetKey", "status");

DO $$ BEGIN
  ALTER TABLE "distribution_leads_pending"
    ADD CONSTRAINT "distribution_leads_pending_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
