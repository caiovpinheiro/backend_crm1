-- Campos do negócio exigidos para o deal entrar na etapa.
ALTER TABLE "stages"
  ADD COLUMN IF NOT EXISTS "required_deal_field_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
