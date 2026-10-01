-- Confirmação de identidade: campos parametrizáveis para validar cliente após identificação.
-- O agente envia uma mensagem interativa com campos-chave do Deal (genéricos) pra o cliente confirmar.

ALTER TABLE "ai_agent_configs" ADD COLUMN "identityConfirmationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_agent_configs" ADD COLUMN "identityConfirmationTemplate" TEXT;
ALTER TABLE "ai_agent_configs" ADD COLUMN "identityConfirmationFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Normalizar: se nenhum campo está setado, deixa o default vazio (não pede confirmação).
