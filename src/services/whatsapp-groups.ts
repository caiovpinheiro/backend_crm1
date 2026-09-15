import { prisma } from "@/lib/prisma";

export type WhatsAppGroupMemberDto = {
  id: string;
  jid: string;
  phone: string | null;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
};

export type WhatsAppGroupListItem = {
  id: string;
  jid: string;
  name: string;
  description: string | null;
  ownerJid: string | null;
  participantCount: number;
  syncedAt: string;
};

export type WhatsAppGroupDetail = WhatsAppGroupListItem & {
  members: WhatsAppGroupMemberDto[];
};

export type BaileysGroupSnapshot = {
  jid: string;
  name: string;
  description: string | null;
  ownerJid: string | null;
  members: Array<{
    jid: string;
    phone: string | null;
    name: string | null;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
};

export async function findConnectedBaileysChannel() {
  return prisma.channel.findFirst({
    where: { provider: "BAILEYS_MD", status: "CONNECTED" },
    select: { id: true, name: true, phoneNumber: true },
    orderBy: { lastConnectedAt: "desc" },
  });
}

export async function listWhatsAppGroups(channelId: string): Promise<WhatsAppGroupListItem[]> {
  const rows = await prisma.whatsAppGroup.findMany({
    where: { channelId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      jid: true,
      name: true,
      description: true,
      ownerJid: true,
      participantCount: true,
      syncedAt: true,
    },
  });
  return rows.map(serializeGroup);
}

export async function getWhatsAppGroup(
  id: string,
  channelId: string,
): Promise<WhatsAppGroupDetail | null> {
  const row = await prisma.whatsAppGroup.findFirst({
    where: { id, channelId },
    include: {
      members: { orderBy: [{ isSuperAdmin: "desc" }, { isAdmin: "desc" }, { name: "asc" }] },
    },
  });
  if (!row) return null;
  return {
    ...serializeGroup(row),
    members: row.members.map((m) => ({
      id: m.id,
      jid: m.jid,
      phone: m.phone,
      name: m.name,
      isAdmin: m.isAdmin,
      isSuperAdmin: m.isSuperAdmin,
    })),
  };
}

export async function replaceChannelGroups(
  organizationId: string,
  channelId: string,
  snapshots: BaileysGroupSnapshot[],
): Promise<number> {
  const seen = snapshots.map((s) => s.jid);
  await prisma.whatsAppGroup.deleteMany({
    where: { channelId, ...(seen.length > 0 ? { jid: { notIn: seen } } : {}) },
  });

  for (const snap of snapshots) {
    const group = await prisma.whatsAppGroup.upsert({
      where: { channelId_jid: { channelId, jid: snap.jid } },
      create: {
        organizationId,
        channelId,
        jid: snap.jid,
        name: snap.name,
        description: snap.description,
        ownerJid: snap.ownerJid,
        participantCount: snap.members.length,
        syncedAt: new Date(),
      },
      update: {
        name: snap.name,
        description: snap.description,
        ownerJid: snap.ownerJid,
        participantCount: snap.members.length,
        syncedAt: new Date(),
      },
      select: { id: true },
    });

    await prisma.whatsAppGroupMember.deleteMany({ where: { groupId: group.id } });
    if (snap.members.length === 0) continue;
    await prisma.whatsAppGroupMember.createMany({
      data: snap.members.map((m) => ({
        organizationId,
        groupId: group.id,
        jid: m.jid,
        phone: m.phone,
        name: m.name,
        isAdmin: m.isAdmin,
        isSuperAdmin: m.isSuperAdmin,
      })),
    });
  }

  return snapshots.length;
}

function serializeGroup(row: {
  id: string;
  jid: string;
  name: string;
  description: string | null;
  ownerJid: string | null;
  participantCount: number;
  syncedAt: Date;
}): WhatsAppGroupListItem {
  return {
    id: row.id,
    jid: row.jid,
    name: row.name,
    description: row.description,
    ownerJid: row.ownerJid,
    participantCount: row.participantCount,
    syncedAt: row.syncedAt.toISOString(),
  };
}
