-- Contador atomico do `number` sequencial por (organizationId, model).
--
-- Substitui o `SELECT MAX(number) + 1` que `lib/prisma.ts allocateNextNumber`
-- fazia antes de cada create de model numerado. Aquele padrao tinha dois
-- defeitos medidos em staging (stress test 23/08):
--   1. a extension de scope injeta `OFFSET`, o que impede o Index Only Scan
--      Backward e fazia a leitura custar 344ms num org com 78k conversas
--      (contra 0,3ms na forma sem OFFSET);
--   2. ler o MAX e inserir em statements separados e uma corrida — 32 slots
--      concorrentes do campaign-worker geraram 27k violacoes de
--      `(organizationId, number)` em 180s.
--
-- A alocacao agora e um unico statement `INSERT ... ON CONFLICT DO UPDATE`,
-- que serializa no row lock desta tabela por (org, model) e devolve a faixa
-- reservada. Sem lock explicito e sem transacao entre leitura e escrita.
CREATE TABLE IF NOT EXISTS "org_number_counters" (
    "organizationId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_number_counters_pkey" PRIMARY KEY ("organizationId", "model")
);
