-- Preço oficial do modelo, lido da página de preços do provedor no
-- "Atualizar modelos" (OpenAI e Anthropic). O código também cria as
-- colunas na primeira vez (DEV não aplica migrations); idempotente.
ALTER TABLE "ai_v2_model_catalog" ADD COLUMN IF NOT EXISTS "officialInputPer1M" DOUBLE PRECISION;
ALTER TABLE "ai_v2_model_catalog" ADD COLUMN IF NOT EXISTS "officialOutputPer1M" DOUBLE PRECISION;
ALTER TABLE "ai_v2_model_catalog" ADD COLUMN IF NOT EXISTS "officialPriceAt" TIMESTAMPTZ;
