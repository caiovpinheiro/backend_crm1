-- Empresas vinculadas ao negócio (várias; uma pode ser a principal).
CREATE TABLE IF NOT EXISTS "deal_companies" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deal_companies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "deal_companies_dealId_companyId_key" ON "deal_companies"("dealId", "companyId");
CREATE INDEX IF NOT EXISTS "deal_companies_organizationId_idx" ON "deal_companies"("organizationId");
CREATE INDEX IF NOT EXISTS "deal_companies_dealId_idx" ON "deal_companies"("dealId");
CREATE INDEX IF NOT EXISTS "deal_companies_companyId_idx" ON "deal_companies"("companyId");
DO $$ BEGIN
  ALTER TABLE "deal_companies" ADD CONSTRAINT "deal_companies_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "deal_companies" ADD CONSTRAINT "deal_companies_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "deal_companies" ADD CONSTRAINT "deal_companies_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
