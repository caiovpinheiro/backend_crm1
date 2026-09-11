-- Módulo de e-mail (IMAP/SMTP). Em produção as tabelas já existem via
-- `db push`; esta migration as materializa no histórico Prisma para
-- ambientes novos (e é idempotente no redeploy).

-- Enums -------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailEncryption') THEN
    CREATE TYPE "EmailEncryption" AS ENUM ('NONE', 'SSL_TLS', 'STARTTLS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailVisibility') THEN
    CREATE TYPE "EmailVisibility" AS ENUM ('SHARED', 'PERSONAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailFolder') THEN
    CREATE TYPE "EmailFolder" AS ENUM ('INBOX', 'SENT', 'TRASH');
  END IF;
END $$;

-- email_accounts ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS "email_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_encrypted" TEXT NOT NULL,
    "imap_host" TEXT NOT NULL,
    "imap_port" INTEGER NOT NULL,
    "imap_encryption" "EmailEncryption" NOT NULL DEFAULT 'SSL_TLS',
    "smtp_host" TEXT NOT NULL,
    "smtp_port" INTEGER NOT NULL,
    "smtp_encryption" "EmailEncryption" NOT NULL DEFAULT 'SSL_TLS',
    "visibility" "EmailVisibility" NOT NULL DEFAULT 'SHARED',
    "group_in_threads" BOOLEAN NOT NULL DEFAULT true,
    "create_contacts_for_replies" BOOLEAN NOT NULL DEFAULT false,
    "owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMP(3),

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_accounts_organizationId_idx"
    ON "email_accounts"("organizationId");
CREATE INDEX IF NOT EXISTS "email_accounts_organizationId_owner_user_id_idx"
    ON "email_accounts"("organizationId", "owner_user_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_organizationId_fkey'
    ) THEN
        ALTER TABLE "email_accounts"
            ADD CONSTRAINT "email_accounts_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_owner_user_id_fkey'
    ) THEN
        ALTER TABLE "email_accounts"
            ADD CONSTRAINT "email_accounts_owner_user_id_fkey"
            FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- email_custom_folders ----------------------------------------------------

CREATE TABLE IF NOT EXISTS "email_custom_folders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_custom_folders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_custom_folders_account_id_name_key"
    ON "email_custom_folders"("account_id", "name");
CREATE INDEX IF NOT EXISTS "email_custom_folders_organizationId_idx"
    ON "email_custom_folders"("organizationId");
CREATE INDEX IF NOT EXISTS "email_custom_folders_account_id_idx"
    ON "email_custom_folders"("account_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_custom_folders_organizationId_fkey'
    ) THEN
        ALTER TABLE "email_custom_folders"
            ADD CONSTRAINT "email_custom_folders_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_custom_folders_account_id_fkey'
    ) THEN
        ALTER TABLE "email_custom_folders"
            ADD CONSTRAINT "email_custom_folders_account_id_fkey"
            FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- emails ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "emails" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "folder" "EmailFolder" NOT NULL DEFAULT 'INBOX',
    "thread_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "uid" TEXT,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "to_address" TEXT NOT NULL,
    "subject" TEXT,
    "body_text" TEXT,
    "body_html" TEXT,
    "contact_id" TEXT,
    "custom_folder_id" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "emails_account_id_message_id_key"
    ON "emails"("account_id", "message_id");
CREATE INDEX IF NOT EXISTS "emails_organizationId_idx"
    ON "emails"("organizationId");
CREATE INDEX IF NOT EXISTS "emails_account_id_folder_idx"
    ON "emails"("account_id", "folder");
CREATE INDEX IF NOT EXISTS "emails_organizationId_thread_id_idx"
    ON "emails"("organizationId", "thread_id");
CREATE INDEX IF NOT EXISTS "emails_account_id_is_read_idx"
    ON "emails"("account_id", "is_read");
CREATE INDEX IF NOT EXISTS "emails_custom_folder_id_idx"
    ON "emails"("custom_folder_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'emails_organizationId_fkey'
    ) THEN
        ALTER TABLE "emails"
            ADD CONSTRAINT "emails_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'emails_account_id_fkey'
    ) THEN
        ALTER TABLE "emails"
            ADD CONSTRAINT "emails_account_id_fkey"
            FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'emails_contact_id_fkey'
    ) THEN
        ALTER TABLE "emails"
            ADD CONSTRAINT "emails_contact_id_fkey"
            FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'emails_custom_folder_id_fkey'
    ) THEN
        ALTER TABLE "emails"
            ADD CONSTRAINT "emails_custom_folder_id_fkey"
            FOREIGN KEY ("custom_folder_id") REFERENCES "email_custom_folders"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- email_rules -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "email_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "condition_field" TEXT NOT NULL,
    "condition_value" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_folder_id" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_rules_organizationId_idx"
    ON "email_rules"("organizationId");
CREATE INDEX IF NOT EXISTS "email_rules_account_id_is_active_priority_idx"
    ON "email_rules"("account_id", "is_active", "priority");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_rules_organizationId_fkey'
    ) THEN
        ALTER TABLE "email_rules"
            ADD CONSTRAINT "email_rules_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_rules_account_id_fkey'
    ) THEN
        ALTER TABLE "email_rules"
            ADD CONSTRAINT "email_rules_account_id_fkey"
            FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_rules_target_folder_id_fkey'
    ) THEN
        ALTER TABLE "email_rules"
            ADD CONSTRAINT "email_rules_target_folder_id_fkey"
            FOREIGN KEY ("target_folder_id") REFERENCES "email_custom_folders"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
