-- Flag para o modo "separate_turn" de boas-vindas + confirmação.
ALTER TABLE "ai_simple_conversation_states" ADD COLUMN IF NOT EXISTS "entryConfirmationPending" BOOLEAN NOT NULL DEFAULT false;
