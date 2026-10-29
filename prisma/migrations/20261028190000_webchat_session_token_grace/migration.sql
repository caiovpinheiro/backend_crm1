-- Webchat: carência do token anterior na rotação (outra aba / poll em voo
-- não toma 401). Colunas anuláveis, sem default: ALTER instantâneo, sem
-- reescrever a tabela. Depende de 20261017190000_webchat_channel.
ALTER TABLE "webchat_sessions" ADD COLUMN IF NOT EXISTS "prevTokenHash" TEXT;
ALTER TABLE "webchat_sessions" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);
