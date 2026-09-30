-- Adiciona `responseBehavior` a AIAgentConfig e mapeia temperaturas legadas.

ALTER TABLE "ai_agent_configs"
  ADD COLUMN "responseBehavior" TEXT DEFAULT 'balanced';

-- Mapeia temperaturas legadas para o behavior mais próximo sem subir o valor.
UPDATE "ai_agent_configs"
SET "responseBehavior" = CASE
  WHEN "temperature" <= 0.3 THEN 'objective'
  WHEN "temperature" <= 0.5 THEN 'balanced'
  WHEN "temperature" <= 0.7 THEN 'natural'
  ELSE 'creative'
END;
