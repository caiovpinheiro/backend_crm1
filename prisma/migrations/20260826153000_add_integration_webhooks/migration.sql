-- Webhooks de saída para integrações (n8n Trigger e similares).

CREATE TABLE IF NOT EXISTS "integration_webhooks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "events" TEXT[] NOT NULL,
  "secret" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "name" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "integration_webhooks_organizationId_url_key"
  ON "integration_webhooks"("organizationId", "url");

CREATE INDEX IF NOT EXISTS "integration_webhooks_organizationId_isActive_idx"
  ON "integration_webhooks"("organizationId", "isActive");

DO $$ BEGIN
  ALTER TABLE "integration_webhooks"
    ADD CONSTRAINT "integration_webhooks_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
