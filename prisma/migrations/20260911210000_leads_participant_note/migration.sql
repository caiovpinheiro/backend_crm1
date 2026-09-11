-- Observação administrativa por consultor no modo leads.
-- Aditivo, nullable: ninguém perde configuração existente.
-- migration-safety: ignore (coluna nova nullable; não altera dados existentes).

ALTER TABLE "distribution_leads_participants"
  ADD COLUMN IF NOT EXISTS "note" TEXT;
