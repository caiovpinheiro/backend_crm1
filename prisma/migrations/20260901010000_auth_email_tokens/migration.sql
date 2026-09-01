-- Verificação de e-mail, reset de senha e convites sem token plaintext.

-- User.emailVerifiedAt (nullable). Grandfather: usuários já existentes
-- ficam verificados para o login atual não quebrar.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
UPDATE "users" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;

-- OrganizationInvite: token legado vira nullable; novos usam só tokenHash.
ALTER TABLE "organization_invites" ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "tokenHash" TEXT;
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "inviteeName" TEXT;
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "pendingRoleId" TEXT;
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "pendingCrmActions" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "organization_invites_tokenHash_key" ON "organization_invites"("tokenHash");

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_userId_createdAt_idx" ON "password_reset_tokens"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_tokens_userId_fkey'
  ) THEN
    ALTER TABLE "password_reset_tokens"
      ADD CONSTRAINT "password_reset_tokens_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_verification_tokens_userId_createdAt_idx" ON "email_verification_tokens"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_userId_codeHash_idx" ON "email_verification_tokens"("userId", "codeHash");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_userId_fkey'
  ) THEN
    ALTER TABLE "email_verification_tokens"
      ADD CONSTRAINT "email_verification_tokens_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
