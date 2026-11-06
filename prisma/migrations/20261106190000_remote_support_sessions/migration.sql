-- Suporte remoto (MeshCentral): sessões de acesso assistido ao computador do
-- cliente, sempre com consentimento dele. Cada sessão aponta para um grupo
-- próprio no MeshCentral; encerrar/expirar apaga o grupo no MeshCentral.
--
-- Permissões: ADMIN já tem `*`. Preset MANAGER recebe `remote_support:*`.
-- MEMBER fica sem por padrão (controlar a máquina do cliente é sensível) —
-- o admin libera em /settings/permissions se a org quiser.

-- CreateEnum
CREATE TYPE "RemoteSupportStatus" AS ENUM ('WAITING', 'CONNECTED', 'ENDED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "remote_support_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "RemoteSupportStatus" NOT NULL DEFAULT 'WAITING',
    "meshId" TEXT,
    "clientToken" TEXT,
    "nodeId" TEXT,
    "deviceName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remote_support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "remote_support_sessions_clientToken_key" ON "remote_support_sessions"("clientToken");

-- CreateIndex
CREATE INDEX "remote_support_sessions_organizationId_contactId_createdAt_idx" ON "remote_support_sessions"("organizationId", "contactId", "createdAt");

-- CreateIndex
CREATE INDEX "remote_support_sessions_organizationId_status_idx" ON "remote_support_sessions"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "remote_support_sessions" ADD CONSTRAINT "remote_support_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_support_sessions" ADD CONSTRAINT "remote_support_sessions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_support_sessions" ADD CONSTRAINT "remote_support_sessions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preset MANAGER: suporte remoto. ADMIN já tem `*`.
UPDATE "roles"
SET "permissions" = ARRAY(
  SELECT DISTINCT k FROM UNNEST(
    "permissions" || ARRAY[
      'remote_support:view',
      'remote_support:start'
    ]::TEXT[]
  ) AS k
),
"updatedAt" = NOW()
WHERE "systemPreset" = 'MANAGER';
