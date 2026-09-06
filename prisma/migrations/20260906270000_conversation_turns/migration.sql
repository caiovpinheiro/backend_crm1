-- Turn Manager (runtime de IA — Fase 1): `conversation_turns`.
--
-- Problema que essa tabela resolve: o debounce de inbound vivia num `Map` de
-- processo com `setTimeout` renovável (src/services/ai/inbound-debounce.ts).
-- Só o `generationId` ia ao Redis (TTL 120s). Restart/deploy/crash mata os
-- timers e a mensagem do cliente fica sem resposta até um cron de resgate
-- passar — minutos de atraso. Aqui o estado de estabilização passa a ser uma
-- LINHA NO BANCO: qualquer processo (API, worker Meta, worker Baileys, cron)
-- reconstrói o que está pendente com um SELECT, sem depender de memória.
--
-- As `messages` NÃO são tocadas: cada bolha do cliente continua sendo uma
-- linha própria. O turno só REFERENCIA os ids em `messageIds` (JSONB) e
-- materializa o texto concatenado em `aggregatedText` na promoção a READY.
--
-- `openKey` e o invariante "no máximo UM turno acumulando por conversa":
--   `openKey` = `conversationId` em RECEIVING/STABILIZING/READY e NULL a
--   partir do claim (PROCESSING) e nos terminais (COMPLETED, INVALIDATED,
--   FAILED). O UNIQUE (organizationId, openKey) com btree NULLS DISTINCT
--   (default do Postgres) dá exatamente a semântica de um unique parcial:
--   dois ingests concorrentes na mesma conversa só conseguem inserir UM
--   turno acumulando, o segundo toma unique_violation (P2002) e o código
--   cai no caminho de append.
--
--   PROCESSING fica FORA da sentinela de propósito: mensagem que chega com
--   o turno já em voo precisa abrir um turno NOVO (não perder input, não
--   alterar o turno em execução). Se PROCESSING travasse a sentinela o
--   ingest não teria onde gravar.
--
--   Por que não `CREATE UNIQUE INDEX ... WHERE status IN (...)` direto:
--   índice parcial não é expressável no schema.prisma e o banco de DEV é
--   gerenciado em estilo `prisma db push`, que DROPA índice que não está no
--   schema. Uma constraint de correção (é ela que dá idempotência na criação
--   concorrente) não pode depender de o operador lembrar de recriar à mão.
--
-- Idempotente (IF NOT EXISTS / DO $$) — o ambiente aplica migrations à mão
-- com SKIP_PRISMA_MIGRATE e re-roda sem medo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConversationTurnStatus') THEN
    CREATE TYPE "ConversationTurnStatus" AS ENUM (
      'RECEIVING',
      'STABILIZING',
      'READY',
      'PROCESSING',
      'COMPLETED',
      'INVALIDATED',
      'FAILED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "conversation_turns" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT,
  "channel" TEXT NOT NULL DEFAULT 'meta',
  "status" "ConversationTurnStatus" NOT NULL DEFAULT 'RECEIVING',
  "openKey" TEXT,
  "messageIds" JSONB NOT NULL DEFAULT '[]',
  "aggregatedText" TEXT,
  -- Janelas congeladas no ingest (org setting `ai.inboundDebounceMs` só é
  -- legível dentro de RequestContext). O sweeper roda cross-org com
  -- prismaBase e decide a promoção sem nenhum lookup por org.
  "debounceMs" INTEGER NOT NULL DEFAULT 1500,
  "maxWaitMs" INTEGER NOT NULL DEFAULT 8000,
  "firstMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),
  "claimedBy" TEXT,
  "completedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_turns_pkey" PRIMARY KEY ("id")
);

-- Invariante de turno aberto único por conversa (ver bloco no topo).
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_turns_organizationId_openKey_key"
  ON "conversation_turns" ("organizationId", "openKey");

-- Lookup do turno aberto da conversa no ingest e no cancelamento.
CREATE INDEX IF NOT EXISTS "conversation_turns_conversationId_status_idx"
  ON "conversation_turns" ("conversationId", "status");

-- Sweeper: fila de READY por ordem de chegada.
CREATE INDEX IF NOT EXISTS "conversation_turns_status_readyAt_idx"
  ON "conversation_turns" ("status", "readyAt");

-- Sweeper: promoção de abertos (janela de debounce por lastMessageAt).
CREATE INDEX IF NOT EXISTS "conversation_turns_status_lastMessageAt_idx"
  ON "conversation_turns" ("status", "lastMessageAt");

-- Sweeper: stale reclaim de PROCESSING travado.
CREATE INDEX IF NOT EXISTS "conversation_turns_status_claimedAt_idx"
  ON "conversation_turns" ("status", "claimedAt");

-- Histórico de turnos de uma conversa (debug/auditoria).
CREATE INDEX IF NOT EXISTS "conversation_turns_organizationId_conversationId_createdAt_idx"
  ON "conversation_turns" ("organizationId", "conversationId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_turns_organizationId_fkey'
  ) THEN
    ALTER TABLE "conversation_turns"
      ADD CONSTRAINT "conversation_turns_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Rastreabilidade: qual turno lógico originou o run. Sem FK de propósito —
-- retenção pode purgar turnos sem arrastar o histórico de runs.
ALTER TABLE "ai_agent_runs"
  ADD COLUMN IF NOT EXISTS "turnId" TEXT;

CREATE INDEX IF NOT EXISTS "ai_agent_runs_turnId_idx"
  ON "ai_agent_runs" ("turnId");
