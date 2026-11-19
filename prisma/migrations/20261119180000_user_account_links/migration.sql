-- "Trocar de organização" sem logout: vínculo entre contas do mesmo e-mail
-- em organizações diferentes (src/lib/auth/org-switch.ts). Tabela nova e
-- vazia: DDL simples, sem CONCURRENTLY. Não altera `users`.
CREATE TABLE IF NOT EXISTS "user_account_links" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "userAVersion" INTEGER NOT NULL,
    "userBVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "user_account_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_account_links_userAId_userBId_key" ON "user_account_links"("userAId", "userBId");
CREATE INDEX IF NOT EXISTS "user_account_links_userBId_idx" ON "user_account_links"("userBId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_account_links_userAId_fkey') THEN
    ALTER TABLE "user_account_links" ADD CONSTRAINT "user_account_links_userAId_fkey"
      FOREIGN KEY ("userAId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_account_links_userBId_fkey') THEN
    ALTER TABLE "user_account_links" ADD CONSTRAINT "user_account_links_userBId_fkey"
      FOREIGN KEY ("userBId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
