-- Chave OpenAI por agente. Null = usa a global de Configurações → IA.
-- `Enc` guarda o valor criptografado (mesma cripto de system_settings);
-- `Hint` guarda só os últimos 4 chars pra UI.

ALTER TABLE "ai_agent_configs"
  ADD COLUMN IF NOT EXISTS "openaiApiKeyEnc" TEXT,
  ADD COLUMN IF NOT EXISTS "openaiApiKeyHint" TEXT;
