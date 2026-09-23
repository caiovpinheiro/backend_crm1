-- Agente IA v2: alinha o banco ao schema.prisma.
--
-- 1) `ai_agent_configs.draftConfig`: a migration 20260920203000 (e o
--    ensure-schema em runtime) criaram a coluna como "draft_config", mas o
--    model `AIAgentConfig.draftConfig` não tem @map — o Prisma lê/escreve
--    "draftConfig". Num banco só com "draft_config" toda query em
--    ai_agent_configs sem select explícito falha (v1 inclusive).
-- 2) `ai_agent_config_versions`: se a tabela veio do ensure-schema antigo,
--    as colunas estão em snake_case ("version_number", "created_by_id").
-- 3) `ai_simple_conversation_states.collectedVariables`: memória da conversa
--    (variáveis coletadas + estado do onboarding) entre turnos.
--
-- Idempotente: cada passo checa o estado atual antes de agir.

DO $$
DECLARE
  has_snake boolean;
  has_camel boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_configs' AND column_name = 'draft_config') INTO has_snake;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_configs' AND column_name = 'draftConfig') INTO has_camel;

  IF has_snake AND NOT has_camel THEN
    ALTER TABLE "ai_agent_configs" RENAME COLUMN "draft_config" TO "draftConfig";
  ELSIF NOT has_camel THEN
    ALTER TABLE "ai_agent_configs" ADD COLUMN "draftConfig" JSONB;
  ELSIF has_snake AND has_camel THEN
    -- Os dois existem (db push + migration): preserva o rascunho que só
    -- está na coluna antiga. A coluna antiga fica — sem uso, sem risco.
    UPDATE "ai_agent_configs"
       SET "draftConfig" = "draft_config"
     WHERE "draftConfig" IS NULL AND "draft_config" IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_config_versions' AND column_name = 'version_number')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_config_versions' AND column_name = 'versionNumber')
  THEN
    ALTER TABLE "ai_agent_config_versions" RENAME COLUMN "version_number" TO "versionNumber";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_config_versions' AND column_name = 'created_by_id')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_config_versions' AND column_name = 'createdById')
  THEN
    ALTER TABLE "ai_agent_config_versions" RENAME COLUMN "created_by_id" TO "createdById";
  END IF;
END $$;

ALTER TABLE "ai_simple_conversation_states"
  ADD COLUMN IF NOT EXISTS "collectedVariables" JSONB NOT NULL DEFAULT '{}';
