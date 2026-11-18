-- Quando a empresa atual foi vinculada ao grupo (automação "Enviar para empresa":
-- sem "todos os grupos", usa o grupo vinculado por último).
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "companyLinkedAt" TIMESTAMP(3);
UPDATE "whatsapp_groups" SET "companyLinkedAt" = "updatedAt"
  WHERE "companyId" IS NOT NULL AND "companyLinkedAt" IS NULL;
