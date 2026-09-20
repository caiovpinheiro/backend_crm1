-- AI v2 full config migration
-- Expand AISimpleConversationState with owner, origin stage, post-close window, counters, etc.
-- Add themeIds to AIAgentKnowledgeDoc for theme-scoped RAG.
-- Create AIV2PendingInteractive and AIV2KnowledgeGap tables.

BEGIN;

ALTER TABLE "ai_simple_conversation_states"
  ADD COLUMN "owner" TEXT NOT NULL DEFAULT 'agente',
  ADD COLUMN "origin_stage_id" TEXT,
  ADD COLUMN "post_close_window_end_at" TIMESTAMPTZ,
  ADD COLUMN "close_reason" TEXT,
  ADD COLUMN "version_id" TEXT,
  ADD COLUMN "theme_id" TEXT,
  ADD COLUMN "counters" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX idx_aisimplecs_conv ON "ai_simple_conversation_states"("conversationId");

ALTER TABLE "ai_agent_knowledge_docs"
  ADD COLUMN "theme_ids" TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE "ai_v2_pending_interactives" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "turnId" TEXT,
  "messageId" TEXT,
  "validUntil" TIMESTAMPTZ NOT NULL,
  "options" JSONB NOT NULL DEFAULT '[]',
  "resolvedAt" TIMESTAMPTZ,
  "resolvedBy" TEXT,
  "resolvedTarget" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aiv2pi_org ON "ai_v2_pending_interactives"("organizationId");
CREATE INDEX idx_aiv2pi_conv ON "ai_v2_pending_interactives"("conversationId");
CREATE INDEX idx_aiv2pi_valid ON "ai_v2_pending_interactives"("validUntil");

CREATE TABLE "ai_v2_knowledge_gaps" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "themeId" TEXT,
  "question" TEXT NOT NULL,
  "frequency" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aiv2kg_org ON "ai_v2_knowledge_gaps"("organizationId");
CREATE INDEX idx_aiv2kg_agent_status ON "ai_v2_knowledge_gaps"("agentId", "status");
CREATE INDEX idx_aiv2kg_updated ON "ai_v2_knowledge_gaps"("updatedAt");

CREATE TABLE "ai_agent_survey_responses" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "dealId" TEXT,
  "agentId" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aisurvey_org ON "ai_agent_survey_responses"("organizationId");
CREATE INDEX idx_aisurvey_agent ON "ai_agent_survey_responses"("agentId", "createdAt");
CREATE INDEX idx_aisurvey_contact ON "ai_agent_survey_responses"("contactId");

COMMIT;
