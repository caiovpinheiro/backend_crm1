-- Apelido do grupo só no CRM (não altera o nome no WhatsApp; a sincronização não mexe).
ALTER TABLE "whatsapp_groups" ADD COLUMN IF NOT EXISTS "customName" TEXT;
