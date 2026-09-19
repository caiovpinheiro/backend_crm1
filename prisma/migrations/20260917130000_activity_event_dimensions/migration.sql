-- Colunas tipadas para dimensões de rollup a partir do log unificado.
-- Backfill em migration separada (Fase 1.2).

ALTER TABLE "activity_events"
    ADD COLUMN "pipelineId" TEXT,
    ADD COLUMN "fromStageId" TEXT,
    ADD COLUMN "toStageId" TEXT,
    ADD COLUMN "tabulationId" TEXT,
    ADD COLUMN "departmentId" TEXT,
    ADD COLUMN "channel" TEXT,
    ADD COLUMN "source" TEXT,
    ADD COLUMN "sourceIsReconstructed" BOOLEAN NOT NULL DEFAULT false;

-- Cursor p/ projector: particionamento por RANGE em occurredAt exige
-- a chave de particao no indice. organizationId na frente permite scan por tenant.
CREATE INDEX "activity_events_org_occurred_at_cursor_idx"
ON "activity_events" ("organizationId", "occurredAt");

-- Checkpoint de scripts operacionais de backfill (fora do deploy).
CREATE TABLE "backfill_checkpoints" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL UNIQUE,
  "entityName" TEXT NOT NULL,
  "lastId" TEXT,
  "lastOccurredAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
