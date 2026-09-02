-- Pilotagem profunda do agente editavel no CRM (sem deploy).
-- Todos nullable: config vazia = fallback para as constantes do codigo.
ALTER TABLE "ai_agent_configs" ADD COLUMN     "steeringRules" TEXT;
ALTER TABLE "ai_agent_configs" ADD COLUMN     "toolConfig" JSONB;
ALTER TABLE "ai_agent_configs" ADD COLUMN     "inboxPolicy" JSONB;
