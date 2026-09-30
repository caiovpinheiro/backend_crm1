-- Renomeia colunas criadas com snake_case no migration ai_v2_full_config
-- para o camelCase que o schema.prisma / Prisma Client espera.
-- Idempotente: ignora se a coluna já estiver no nome destino.

BEGIN;

DO $$
BEGIN
  -- ai_simple_conversation_states
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'origin_stage_id')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'originStageId')
  THEN
    ALTER TABLE "ai_simple_conversation_states" RENAME COLUMN "origin_stage_id" TO "originStageId";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'post_close_window_end_at')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'postCloseWindowEndAt')
  THEN
    ALTER TABLE "ai_simple_conversation_states" RENAME COLUMN "post_close_window_end_at" TO "postCloseWindowEndAt";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'close_reason')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'closeReason')
  THEN
    ALTER TABLE "ai_simple_conversation_states" RENAME COLUMN "close_reason" TO "closeReason";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'version_id')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'versionId')
  THEN
    ALTER TABLE "ai_simple_conversation_states" RENAME COLUMN "version_id" TO "versionId";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'theme_id')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_simple_conversation_states' AND column_name = 'themeId')
  THEN
    ALTER TABLE "ai_simple_conversation_states" RENAME COLUMN "theme_id" TO "themeId";
  END IF;

  -- ai_agent_knowledge_docs
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_knowledge_docs' AND column_name = 'theme_ids')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_agent_knowledge_docs' AND column_name = 'themeIds')
  THEN
    ALTER TABLE "ai_agent_knowledge_docs" RENAME COLUMN "theme_ids" TO "themeIds";
  END IF;
END $$;

COMMIT;
