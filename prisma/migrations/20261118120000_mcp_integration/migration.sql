-- Integração MCP (ChatGPT, Claude, Cursor): clientes OAuth (DCR), conexões
-- autorizadas, credenciais OAuth (só hash) e histórico de consultas.
-- Só tabelas novas; nenhuma tabela existente é alterada.
-- CreateTable
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientUri" TEXT,
    "logoUri" TEXT,
    "redirectUris" TEXT[],
    "clientSecretHash" TEXT,
    "registeredIpHash" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "mcp_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "mcp_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[],
    "codeChallenge" TEXT,
    "redirectUri" TEXT,
    "resource" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "mcp_audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "userId" TEXT,
    "tool" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "args" JSONB,
    "resultCount" INTEGER,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_clients_clientId_key" ON "mcp_oauth_clients"("clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mcp_connections_organizationId_revokedAt_idx" ON "mcp_connections"("organizationId", "revokedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mcp_connections_userId_clientId_idx" ON "mcp_connections"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_tokens_tokenHash_key" ON "mcp_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mcp_tokens_connectionId_kind_idx" ON "mcp_tokens"("connectionId", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mcp_tokens_expiresAt_idx" ON "mcp_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mcp_audit_logs_organizationId_createdAt_idx" ON "mcp_audit_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mcp_audit_logs_connectionId_createdAt_idx" ON "mcp_audit_logs"("connectionId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mcp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_audit_logs" ADD CONSTRAINT "mcp_audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "mcp_audit_logs" ADD CONSTRAINT "mcp_audit_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mcp_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

