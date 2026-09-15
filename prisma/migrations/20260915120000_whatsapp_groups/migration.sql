-- Cache dos grupos da conta WhatsApp QR (Baileys). Não é o stub Group.

CREATE TABLE "whatsapp_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "ownerJid" TEXT,
    "participantCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_group_members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "whatsapp_group_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_groups_channelId_jid_key" ON "whatsapp_groups"("channelId", "jid");
CREATE INDEX "whatsapp_groups_organizationId_idx" ON "whatsapp_groups"("organizationId");
CREATE INDEX "whatsapp_groups_channelId_idx" ON "whatsapp_groups"("channelId");
CREATE UNIQUE INDEX "whatsapp_group_members_groupId_jid_key" ON "whatsapp_group_members"("groupId", "jid");
CREATE INDEX "whatsapp_group_members_organizationId_idx" ON "whatsapp_group_members"("organizationId");
CREATE INDEX "whatsapp_group_members_groupId_idx" ON "whatsapp_group_members"("groupId");

ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_group_members" ADD CONSTRAINT "whatsapp_group_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_group_members" ADD CONSTRAINT "whatsapp_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "whatsapp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "roles"
SET "permissions" = ARRAY(
  SELECT DISTINCT k FROM UNNEST(
    "permissions" || ARRAY[
      'nav:whatsapp-groups',
      'whatsapp_group:view',
      'whatsapp_group:send'
    ]::TEXT[]
  ) AS k
),
"updatedAt" = NOW()
WHERE "systemPreset" IN ('MANAGER', 'MEMBER');
