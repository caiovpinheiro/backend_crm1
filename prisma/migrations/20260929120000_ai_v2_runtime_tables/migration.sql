-- Tabelas do agente v2 que o código criava sozinho na primeira vez que a
-- função era usada (Revisar com IA, Relatório de feedback, Aprender com
-- conversas, Escutar a equipe, anexos de material, transcrição de mídia e
-- comparador). Idempotente: em ambiente onde o código já criou, nada muda.

-- Revisar com IA
CREATE TABLE IF NOT EXISTS "ai_v2_config_reviews" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "result" JSONB,
  "error" TEXT,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "ai_v2_config_reviews_agent_idx" ON "ai_v2_config_reviews" ("organizationId", "agentId", "createdAt");

-- Relatório de feedback
CREATE TABLE IF NOT EXISTS "ai_v2_feedback_reports" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "stats" JSONB,
  "total" INTEGER NOT NULL DEFAULT 0,
  "done" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "ai_v2_feedback_reports_agent_idx" ON "ai_v2_feedback_reports" ("organizationId", "agentId", "createdAt");

CREATE TABLE IF NOT EXISTS "ai_v2_feedback_items" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" INTEGER NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "minor" BOOLEAN NOT NULL DEFAULT false,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "target" JSONB,
  "recommendation" JSONB,
  "conversations" INTEGER NOT NULL DEFAULT 0,
  "evidenceCount" INTEGER NOT NULL DEFAULT 0,
  "evidences" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'open',
  "statusAt" TIMESTAMPTZ,
  "statusById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_v2_feedback_items_report_idx" ON "ai_v2_feedback_items" ("reportId");

-- Aprender com conversas
CREATE TABLE IF NOT EXISTS "ai_v2_learn_runs" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "stats" JSONB,
  "result" JSONB,
  "total" INTEGER NOT NULL DEFAULT 0,
  "done" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "ai_v2_learn_runs_agent_idx" ON "ai_v2_learn_runs" ("organizationId", "agentId", "createdAt");

-- Escutar a equipe
CREATE TABLE IF NOT EXISTS "ai_v2_listen_sessions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "userIds" JSONB NOT NULL,
  "mode" TEXT NOT NULL,
  "startsAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "endsAt" TIMESTAMPTZ,
  "maxUsdPerDay" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "maxConversationsPerDay" INTEGER NOT NULL DEFAULT 60,
  "lastSweepAt" TIMESTAMPTZ,
  "stats" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL,
  "statusById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_v2_listen_sessions_agent_idx" ON "ai_v2_listen_sessions" ("organizationId", "agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_v2_listen_sessions_status_idx" ON "ai_v2_listen_sessions" ("status", "lastSweepAt");

CREATE TABLE IF NOT EXISTS "ai_v2_listen_samples" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "conversationNumber" INTEGER,
  "userIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "watermarkAt" TIMESTAMPTZ NOT NULL,
  "messages" INTEGER NOT NULL DEFAULT 0,
  "analysis" JSONB,
  "outcome" TEXT,
  "skipped" TEXT,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_v2_listen_samples_conv_uq" ON "ai_v2_listen_samples" ("sessionId", "conversationId");

CREATE TABLE IF NOT EXISTS "ai_v2_listen_proposals" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "occurrences" INTEGER NOT NULL DEFAULT 0,
  "sampleCount" INTEGER NOT NULL DEFAULT 0,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "payload" JSONB NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "error" TEXT,
  "statusAt" TIMESTAMPTZ,
  "statusById" TEXT,
  "appliedRef" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_v2_listen_proposals_agent_idx" ON "ai_v2_listen_proposals" ("organizationId", "agentId", "status");

CREATE TABLE IF NOT EXISTS "ai_v2_listen_runs" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "total" INTEGER NOT NULL DEFAULT 0,
  "done" INTEGER NOT NULL DEFAULT 0,
  "stats" JSONB,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "ai_v2_listen_runs_session_idx" ON "ai_v2_listen_runs" ("sessionId", "createdAt");

-- Anexos de material
CREATE TABLE IF NOT EXISTS "ai_v2_material_attachments" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "docId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mimeType" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_v2_material_attachments_doc_idx" ON "ai_v2_material_attachments" ("agentId", "docId");
ALTER TABLE "ai_v2_material_attachments" ADD COLUMN IF NOT EXISTS "autoSend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_v2_material_attachments" ADD COLUMN IF NOT EXISTS "resendWindow" TEXT NOT NULL DEFAULT '7d';

-- Transcrição e leitura de mídia (cache por mensagem)
CREATE TABLE IF NOT EXISTS "ai_simple_media_texts" (
  "messageId" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comparador com a equipe
CREATE TABLE IF NOT EXISTS "ai_simple_replay_runs" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "total" INTEGER NOT NULL DEFAULT 0,
  "done" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB,
  "error" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "ai_simple_replay_runs_agent_idx" ON "ai_simple_replay_runs" ("organizationId", "agentId", "createdAt");

CREATE TABLE IF NOT EXISTS "ai_simple_replay_items" (
  "id" TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "pointIndex" INTEGER NOT NULL,
  "at" TIMESTAMPTZ,
  "clientText" TEXT NOT NULL,
  "humanText" TEXT NOT NULL,
  "agentText" TEXT,
  "agentHandoff" BOOLEAN NOT NULL DEFAULT false,
  "themeName" TEXT,
  "sources" JSONB,
  "verdict" JSONB,
  "skipReason" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE "ai_simple_replay_items" ADD COLUMN IF NOT EXISTS "history" JSONB;
ALTER TABLE "ai_simple_replay_items" ADD COLUMN IF NOT EXISTS "facts" JSONB;
ALTER TABLE "ai_simple_replay_items" ADD COLUMN IF NOT EXISTS "latencyMs" INTEGER;
CREATE INDEX IF NOT EXISTS "ai_simple_replay_items_run_idx" ON "ai_simple_replay_items" ("runId");
