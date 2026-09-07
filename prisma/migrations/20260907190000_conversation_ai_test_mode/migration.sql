-- Modo de teste do agente de IA, por conversa.
--
-- Duas colunas nullable: ADD COLUMN sem default não reescreve a tabela, então
-- é seguro em `conversations` (tabela quente). Sem índice de propósito — a
-- leitura é sempre por `id` da conversa, dentro do lookup que o inbox-handler
-- já faz.
ALTER TABLE "conversations" ADD COLUMN "aiTestModeUntil" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "aiTestModeById" TEXT;
