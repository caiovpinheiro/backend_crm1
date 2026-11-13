-- Grupo WhatsApp vinculado a uma empresa do CRM (uma por grupo).
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
CREATE INDEX IF NOT EXISTS "whatsapp_groups_companyId_idx" ON "whatsapp_groups"("companyId");
DO $$ BEGIN
  ALTER TABLE "whatsapp_groups"
    ADD CONSTRAINT "whatsapp_groups_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
