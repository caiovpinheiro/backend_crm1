-- Coluna `updatedAt` em `campaign_recipients` — base do sweeper de
-- recipients SENDING travados no consumo por rodízio da fila de envio
-- (campaign-worker). Nullable + sem default: ADD COLUMN metadata-only,
-- instantâneo mesmo com a tabela grande.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);
