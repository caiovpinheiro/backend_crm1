-- Modelos Internos por agente (antes: gate hardcoded em archetype='ATENDIMENTO').
-- Backfill preserva o comportamento atual dos agentes de atendimento.

ALTER TABLE "ai_agent_configs"
  ADD COLUMN IF NOT EXISTS "useInternalModels" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ai_agent_configs"
  SET "useInternalModels" = true
  WHERE archetype = 'ATENDIMENTO';
