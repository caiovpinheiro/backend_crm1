-- Relay SMTP (smarthost) por org — fallback de saída quando o provedor de
-- cloud bloqueia 465/587 na borda de rede. Editável em /settings/smtp-relay
-- (UI por tenant), com precedência sobre as envs SMTP_RELAY_* (legado
-- global). Senha em `password_encrypted` via encryptSecret()
-- (KEYRING_SECRET), mesmo padrão de `email_accounts`. Aditivo e idempotente.

CREATE TABLE IF NOT EXISTS "smtp_relay_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 587,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "password_encrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smtp_relay_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "smtp_relay_configs_organizationId_key"
    ON "smtp_relay_configs"("organizationId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'smtp_relay_configs_organizationId_fkey'
    ) THEN
        ALTER TABLE "smtp_relay_configs"
            ADD CONSTRAINT "smtp_relay_configs_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
