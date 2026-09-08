-- Encerramento automático parametrizado no widget Agente de IA.
-- Null = modo understood (a IA pode encerrar, comportamento atual).

ALTER TABLE "ai_agent_configs"
  ADD COLUMN IF NOT EXISTS "autoClosePolicy" JSONB;
