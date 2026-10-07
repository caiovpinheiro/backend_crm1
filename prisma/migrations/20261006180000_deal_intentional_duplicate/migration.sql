-- Duplicar intencional: o card criado pelo operador não entra na unificação.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "intentionalDuplicate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "duplicatedFromDealId" TEXT;
