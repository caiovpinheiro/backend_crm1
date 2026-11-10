-- Chave do provedor de voz por agente (resposta por áudio), cifrada como a
-- da OpenAI. Sem a chave nada muda: o agente segue respondendo em texto.
ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "voiceApiKeyEnc" TEXT;
ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "voiceApiKeyHint" TEXT;
