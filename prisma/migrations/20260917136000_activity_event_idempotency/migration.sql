-- Chave de idempotência para eventos projetados pela outbox.
-- Garante que um reprocessamento do worker (crash após inserção em
-- activity_events e antes do processedAt) não duplique a linha final.
-- NULL é permitido e não entra em conflito (UNIQUE do Postgres ignora
-- NULLs), então eventos fire-and-forget continuam sem chave.

ALTER TABLE "activity_events"
    ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "activity_events_org_idempotency_idx"
ON "activity_events" ("organizationId", "idempotencyKey");
