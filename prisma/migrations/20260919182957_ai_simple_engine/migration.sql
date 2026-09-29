-- Adiciona engine na configuração do agente para ativar a v2 simples.
-- Cria tabelas de estado por conversa e log de turno da v2.

ALTER TABLE "ai_agent_configs"
  ADD COLUMN "engine" TEXT DEFAULT 'legacy',
  ADD COLUMN "simpleConfig" JSONB;

CREATE INDEX "ai_agent_configs_engine_idx" ON "ai_agent_configs"("engine");

CREATE TABLE "ai_simple_conversation_states" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'new',
  "mode" TEXT,
  "humanActive" BOOLEAN NOT NULL DEFAULT false,
  "identificationAttempts" INT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_simple_conversation_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_simple_conversation_states_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_simple_conversation_states_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_simple_conversation_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ai_simple_conversation_states_conversationId_key" ON "ai_simple_conversation_states"("conversationId");
CREATE INDEX "ai_simple_conversation_states_agentId_idx" ON "ai_simple_conversation_states"("agentId");
CREATE INDEX "ai_simple_conversation_states_organizationId_idx" ON "ai_simple_conversation_states"("organizationId");

CREATE TABLE "ai_simple_turn_logs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "turnId" TEXT,
  "inboundText" TEXT NOT NULL,
  "contextSnapshot" JSONB NOT NULL DEFAULT '{}',
  "prompt" TEXT NOT NULL,
  "llmOutput" JSONB,
  "discardedActions" JSONB NOT NULL DEFAULT '[]',
  "executedActions" JSONB NOT NULL DEFAULT '[]',
  "reply" TEXT,
  "handoff" BOOLEAN NOT NULL DEFAULT false,
  "error" TEXT,
  "latencyMs" INT,
  "inputTokens" INT NOT NULL DEFAULT 0,
  "outputTokens" INT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_simple_turn_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_simple_turn_logs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_simple_turn_logs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_simple_turn_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ai_simple_turn_logs_conversationId_idx" ON "ai_simple_turn_logs"("conversationId");
CREATE INDEX "ai_simple_turn_logs_agentId_idx" ON "ai_simple_turn_logs"("agentId");
CREATE INDEX "ai_simple_turn_logs_organizationId_idx" ON "ai_simple_turn_logs"("organizationId");
CREATE INDEX "ai_simple_turn_logs_turnId_idx" ON "ai_simple_turn_logs"("turnId");
