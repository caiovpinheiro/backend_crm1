-- Adiciona tipo de feedback opcional às mensagens do Bwipo Chat.
ALTER TABLE "team_chat_messages" ADD COLUMN "feedbackType" TEXT;
