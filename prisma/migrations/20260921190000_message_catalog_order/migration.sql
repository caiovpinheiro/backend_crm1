-- Pedido do catálogo WhatsApp (webhook type=order). Nullable: mensagens antigas ficam sem snapshot.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "catalog_order" JSONB;
