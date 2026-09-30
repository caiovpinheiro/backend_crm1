-- Agente IA: chave Anthropic por agente (modelos Claude), cifrada.
ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "anthropicApiKeyEnc" TEXT;
ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "anthropicApiKeyHint" TEXT;
