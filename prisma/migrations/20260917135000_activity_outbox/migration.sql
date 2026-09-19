-- Outbox transacional para o Activity Log.
-- Garante que eventos que alimentam rollups sejam persistidos na mesma
-- transacao da mutacao de negocio. Worker poll consome e projeta em
-- activity_events.

CREATE TABLE "activity_outbox" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scheduledFor" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "deadLetterAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'
);

-- Idempotencia por org: mesmo evento nao pode ser enfileirado 2x.
CREATE UNIQUE INDEX "activity_outbox_org_idempotency_idx"
ON "activity_outbox" ("organizationId", "idempotencyKey");

-- Indice parcial para o poll do worker: so ve itens pendentes e ordenados.
-- FOR UPDATE SKIP LOCKED evita contencao entre multiplos workers.
CREATE INDEX "activity_outbox_poll_idx"
ON "activity_outbox" ("organizationId", "scheduledFor")
WHERE "processedAt" IS NULL AND "deadLetterAt" IS NULL;

-- Indice util para limpeza diaria de itens processados.
CREATE INDEX "activity_outbox_cleanup_idx"
ON "activity_outbox" ("processedAt")
WHERE "processedAt" IS NOT NULL;
