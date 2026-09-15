import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { normalizePhone, phoneMatchVariants } from "@/lib/phone";
import { insertContactWithNextNumber } from "@/services/contacts";
import {
  activeConversationOnAccountWhere,
  withConversationNumberRetry,
} from "@/services/conversations";

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

export type WhatsAppGroupMessageDto = {
  id: string;
  fromJid: string;
  fromName: string | null;
  fromPhone: string | null;
  fromMe: boolean;
  text: string;
  createdAt: string;
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

export async function listWhatsAppGroupMessages(
  groupId: string,
  limit = 80,
): Promise<WhatsAppGroupMessageDto[]> {
  const rows = await prisma.whatsAppGroupMessage.findMany({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      fromJid: true,
      fromName: true,
      fromPhone: true,
      fromMe: true,
      text: true,
      createdAt: true,
    },
  });
  return rows.reverse().map((r) => ({
    id: r.id,
    fromJid: r.fromJid,
    fromName: r.fromName,
    fromPhone: r.fromPhone,
    fromMe: r.fromMe,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function appendWhatsAppGroupMessage(input: {
  organizationId: string;
  groupId: string;
  waMessageId?: string | null;
  fromJid: string;
  fromName?: string | null;
  fromPhone?: string | null;
  fromMe: boolean;
  text: string;
}): Promise<WhatsAppGroupMessageDto | null> {
  const text = input.text.trim();
  if (!text) return null;
  if (input.waMessageId) {
    const dup = await prisma.whatsAppGroupMessage.findFirst({
      where: { groupId: input.groupId, waMessageId: input.waMessageId },
      select: { id: true },
    });
    if (dup) return null;
  }
  const row = await prisma.whatsAppGroupMessage.create({
    data: withOrgFromCtx({
      organizationId: input.organizationId,
      groupId: input.groupId,
      waMessageId: input.waMessageId ?? null,
      fromJid: input.fromJid,
      fromName: input.fromName ?? null,
      fromPhone: input.fromPhone ?? null,
      fromMe: input.fromMe,
      text: text.slice(0, 4096),
    }),
    select: {
      id: true,
      fromJid: true,
      fromName: true,
      fromPhone: true,
      fromMe: true,
      text: true,
      createdAt: true,
    },
  });
  return {
    id: row.id,
    fromJid: row.fromJid,
    fromName: row.fromName,
    fromPhone: row.fromPhone,
    fromMe: row.fromMe,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function findWhatsAppGroupByJid(channelId: string, jid: string) {
  return prisma.whatsAppGroup.findFirst({
    where: { channelId, jid },
    select: { id: true, organizationId: true },
  });
}

export async function openWhatsAppGroupMember(input: {
  groupId: string;
  memberId: string;
  channelId: string;
}): Promise<
  | { contactId: string; conversationId: string; dealId: string | null }
  | { error: string; status: number }
> {
  const member = await prisma.whatsAppGroupMember.findFirst({
    where: { id: input.memberId, groupId: input.groupId },
    select: { id: true, phone: true, name: true, jid: true },
  });
  if (!member) return { error: "Participante não encontrado.", status: 404 };

  const phone = normalizePhone(member.phone ?? "") ?? null;
  if (!phone) {
    return {
      error: "Este participante não tem telefone visível. Não dá para abrir no inbox.",
      status: 409,
    };
  }

  const variants = phoneMatchVariants(phone);
  let contact = await prisma.contact.findFirst({
    where: { phone: { in: variants.length ? variants : [phone] } },
    select: { id: true, name: true, phone: true, assignedToId: true },
  });
  if (!contact) {
    contact = await insertContactWithNextNumber(
      { name: member.name?.trim() || phone, phone },
      { id: true, name: true, phone: true, assignedToId: true },
    );
  }

  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { id: true, name: true },
  });

  const findOnAccount = (accountId: string | null) =>
    prisma.conversation.findFirst({
      where: activeConversationOnAccountWhere({
        contactId: contact.id,
        channel: "whatsapp",
        channelId: accountId,
      }),
      select: { id: true },
    });

  let conversation = await findOnAccount(input.channelId);
  if (!conversation) {
    conversation = await findOnAccount(null);
    if (conversation) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { channelId: input.channelId, inboxName: channel?.name ?? undefined },
      });
    }
  }
  if (!conversation) {
    conversation = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          channel: "whatsapp",
          status: "OPEN" as const,
          inboxName: channel?.name ?? null,
          contactId: contact.id,
          channelId: input.channelId,
          ...(contact.assignedToId ? { assignedToId: contact.assignedToId } : {}),
        }),
        select: { id: true },
      }),
    );
  }

  const deal = await prisma.deal.findFirst({
    where: { contactId: contact.id, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  return {
    contactId: contact.id,
    conversationId: conversation.id,
    dealId: deal?.id ?? null,
  };
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
