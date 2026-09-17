-- Outbox transacional do Activity Log (model ActivityOutbox).
--
-- O model e o código (`services/activity-outbox.ts`, chamado pelo
-- encerramento de conversa) foram mergeados SEM esta migration, então
-- `insertActivityOutbox` estourava `42P01 relation "activity_outbox" does
-- not exist` e abortava a transação do PATCH de status.
CREATE TABLE IF NOT EXISTS "activity_outbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "deadLetterAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    CONSTRAINT "activity_outbox_pkey" PRIMARY KEY ("id")
);

-- Exigido pelo `ON CONFLICT ("organizationId", "idempotencyKey")` do insert.
CREATE UNIQUE INDEX IF NOT EXISTS "activity_outbox_org_idempotency_idx"
    ON "activity_outbox" ("organizationId", "idempotencyKey");

-- `runLogEvent` grava esta coluna quando o evento vem da outbox; sem ela a
-- projeção falharia com 42703 assim que um item fosse consumido.
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- Sem índice em ("organizationId", "idempotencyKey") de propósito:
--   1. UNIQUE é impossível ali — a tabela é particionada por
--      RANGE("occurredAt") desde 20260606170000_partition_activity_events e o
--      Postgres exige a coluna de partição em índice UNIQUE de particionada;
--   2. um btree comum no pai se constrói nas 49 partições (~3,8 GB) com lock
--      exclusivo, e migration roda no boot da API (APP_MODE=api).
-- Nada em execução consulta essa coluna: a projeção da outbox (o único
-- `findFirst` por idempotencyKey) ainda não tem consumidor rodando. Quando
-- ela for ligada, criar por partição com CREATE INDEX CONCURRENTLY, fora do
-- ciclo de migration.
