-- Catálogo de modelos por organização ("Atualizar modelos" na tela do
-- agente v2): modelos descobertos na OpenAI/Anthropic, preço informado pelo
-- admin e o registro de cada atualização (quem e quando). O código também
-- cria as tabelas na primeira vez (DEV não aplica migrations); idempotente.

CREATE TABLE IF NOT EXISTS "ai_v2_model_catalog" (
  "organizationId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "label" TEXT,
  "providerCreatedAt" TIMESTAMPTZ,
  "firstSeenAt" TIMESTAMPTZ,
  "lastSeenAt" TIMESTAMPTZ,
  "missingSince" TIMESTAMPTZ,
  "inputPer1M" DOUBLE PRECISION,
  "outputPer1M" DOUBLE PRECISION,
  "priceUpdatedById" TEXT,
  "priceUpdatedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("organizationId", "modelId")
);

CREATE TABLE IF NOT EXISTS "ai_v2_model_catalog_refreshes" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ,
  "result" JSONB
);
CREATE INDEX IF NOT EXISTS "ai_v2_model_catalog_refreshes_org_idx" ON "ai_v2_model_catalog_refreshes" ("organizationId", "startedAt");
