-- Armazena o negócio escolhido pelo cliente em conversas com múltiplos negócios abertos.
ALTER TABLE "ai_simple_conversation_states" ADD COLUMN IF NOT EXISTS "selectedDealId" TEXT;
