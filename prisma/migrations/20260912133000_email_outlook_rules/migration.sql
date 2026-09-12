-- Regras estilo Outlook: encaminhar, responder, spam, corpo/sempre;
-- ausência (OOO) na conta; auto_handled para não repetir envio.

ALTER TABLE "email_rules"
  ADD COLUMN IF NOT EXISTS "action_target" TEXT,
  ADD COLUMN IF NOT EXISTS "action_body" TEXT;

ALTER TABLE "email_accounts"
  ADD COLUMN IF NOT EXISTS "ooo_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ooo_message" TEXT,
  ADD COLUMN IF NOT EXISTS "ooo_starts_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ooo_ends_at" TIMESTAMP(3);

ALTER TABLE "emails"
  ADD COLUMN IF NOT EXISTS "auto_handled" BOOLEAN NOT NULL DEFAULT false;
