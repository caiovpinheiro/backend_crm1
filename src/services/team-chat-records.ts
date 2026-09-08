/**
 * Resolução de registros CRM para o WiPO Chat.
 * O card é resolvido por leitor — nunca cacheie o preview renderizado.
 */

import type { AppUserRole } from "@/lib/auth-types";
import { can, checkPermission, loadAuthzContext } from "@/lib/authz";
import { userHasConversationAccess } from "@/lib/conversation-access";
import {
  hrefForAnchor,
  parseCrmInternalUrl,
  previewLabelForAnchor,
  type CrmAnchorType,
  type CrmInternalRef,
} from "@/lib/crm-internal-url";
import { prisma } from "@/lib/prisma";
import { idOrNumberWhere } from "@/lib/public-id";
import { getVisibilityFilter } from "@/lib/visibility";
import { logEvent } from "@/services/activity-log";
import type { TeamChatViewer } from "@/services/team-chat";

export type ResolvedCrmCard = {
  kind: "crm";
  restricted: false;
  type: CrmAnchorType;
  id: string;
  number: number | null;
  title: string;
  typeLabel: string;
  status: string | null;
  ownerName: string | null;
  value: number | null;
  href: string;
};

export type RestrictedCrmCard = {
  kind: "crm";
  restricted: true;
  type: CrmAnchorType;
  typeLabel: string;
};

export type CrmCard = ResolvedCrmCard | RestrictedCrmCard;

type AccessUser = {
  id: string;
  role: AppUserRole;
  organizationId: string;
  isSuperAdmin: boolean;
};

const TYPE_LABEL: Record<CrmAnchorType, string> = {
  deal: "Negócio",
  conversation: "Atendimento",
  contact: "Contato",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Aberto",
  WON: "Ganho",
  LOST: "Perdido",
  RESOLVED: "Resolvido",
  PENDING: "Pendente",
  SNOOZED: "Snoozed",
};

async function loadAccessUser(userId: string, organizationId: string): Promise<AccessUser | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId },
    select: { id: true, role: true, organizationId: true, isSuperAdmin: true },
  });
  if (!user?.organizationId) return null;
  return {
    id: user.id,
    role: user.role as AppUserRole,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  };
}

async function resolveRecordIds(
  orgId: string,
  ref: CrmInternalRef,
): Promise<{ id: string; number: number | null } | null> {
  if (ref.type === "deal") {
    const row = await prisma.deal.findUnique({
      where: idOrNumberWhere(orgId, ref.id) as { id: string } | { organizationId_number: { organizationId: string; number: number } },
      select: { id: true, number: true },
    });
    return row;
  }
  if (ref.type === "conversation") {
    const row = await prisma.conversation.findUnique({
      where: idOrNumberWhere(orgId, ref.id) as { id: string } | { organizationId_number: { organizationId: string; number: number } },
      select: { id: true, number: true },
    });
    return row;
  }
  const row = await prisma.contact.findUnique({
    where: idOrNumberWhere(orgId, ref.id) as { id: string } | { organizationId_number: { organizationId: string; number: number } },
    select: { id: true, number: true },
  });
  return row;
}

export async function userCanSeeRecord(
  user: AccessUser,
  type: CrmAnchorType,
  recordId: string,
): Promise<boolean> {
  const authz = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  });

  if (type === "deal") {
    if (!can(authz, "deal:view")) return false;
    const vis = await getVisibilityFilter({
      id: user.id,
      role: user.role,
    });
    const n = await prisma.deal.count({
      where: { AND: [{ id: recordId }, vis.dealWhere] },
    });
    return n > 0;
  }

  if (type === "conversation") {
    if (!can(authz, "conversation:view")) return false;
    return userHasConversationAccess(user, recordId);
  }

  return can(authz, "contact:view");
}

export async function resolveCrmCardForViewer(
  viewer: TeamChatViewer,
  ref: CrmInternalRef,
): Promise<CrmCard | null> {
  const ids = await resolveRecordIds(viewer.organizationId, ref);
  if (!ids) return null;

  const user = await loadAccessUser(viewer.userId, viewer.organizationId);
  const typeLabel = TYPE_LABEL[ref.type];
  if (!user || !(await userCanSeeRecord(user, ref.type, ids.id))) {
    return { kind: "crm", restricted: true, type: ref.type, typeLabel };
  }

  if (ref.type === "deal") {
    const deal = await prisma.deal.findFirst({
      where: { id: ids.id },
      select: {
        id: true,
        number: true,
        title: true,
        value: true,
        status: true,
        owner: { select: { name: true } },
      },
    });
    if (!deal) return { kind: "crm", restricted: true, type: ref.type, typeLabel };
    return {
      kind: "crm",
      restricted: false,
      type: "deal",
      id: deal.id,
      number: deal.number,
      title: deal.title,
      typeLabel,
      status: STATUS_LABEL[deal.status] ?? deal.status,
      ownerName: deal.owner?.name ?? null,
      value: Number(deal.value),
      href: hrefForAnchor("deal", deal.number),
    };
  }

  if (ref.type === "conversation") {
    const conv = await prisma.conversation.findFirst({
      where: { id: ids.id },
      select: {
        id: true,
        number: true,
        status: true,
        contact: { select: { name: true } },
        assignedTo: { select: { name: true } },
      },
    });
    if (!conv) return { kind: "crm", restricted: true, type: ref.type, typeLabel };
    return {
      kind: "crm",
      restricted: false,
      type: "conversation",
      id: conv.id,
      number: conv.number,
      title: conv.contact?.name || `Atendimento #${conv.number}`,
      typeLabel,
      status: STATUS_LABEL[conv.status] ?? conv.status,
      ownerName: conv.assignedTo?.name ?? null,
      value: null,
      href: hrefForAnchor("conversation", conv.number),
    };
  }

  const contact = await prisma.contact.findFirst({
    where: { id: ids.id },
    select: { id: true, number: true, name: true, assignedTo: { select: { name: true } } },
  });
  if (!contact) return { kind: "crm", restricted: true, type: ref.type, typeLabel };
  return {
    kind: "crm",
    restricted: false,
    type: "contact",
    id: contact.id,
    number: contact.number,
    title: contact.name,
    typeLabel,
    status: null,
    ownerName: contact.assignedTo?.name ?? null,
    value: null,
    href: hrefForAnchor("contact", contact.number),
  };
}

export async function previewLabelForRef(
  orgId: string,
  ref: CrmInternalRef,
): Promise<string> {
  const ids = await resolveRecordIds(orgId, ref);
  if (!ids) return previewLabelForAnchor(ref.type);
  if (ref.type === "deal") {
    const deal = await prisma.deal.findFirst({
      where: { id: ids.id },
      select: { number: true, title: true },
    });
    return previewLabelForAnchor("deal", deal?.number, deal?.title);
  }
  if (ref.type === "conversation") {
    return previewLabelForAnchor("conversation", ids.number);
  }
  const contact = await prisma.contact.findFirst({
    where: { id: ids.id },
    select: { number: true, name: true },
  });
  return previewLabelForAnchor("contact", contact?.number, contact?.name);
}

export async function resolveAnchorInput(
  orgId: string,
  input?: { type: string; id: string } | null,
): Promise<{ type: CrmAnchorType | "work_item"; id: string } | null> {
  if (!input?.type || !input.id) return null;
  if (input.type === "work_item") return { type: "work_item", id: input.id };
  if (input.type !== "deal" && input.type !== "conversation" && input.type !== "contact") {
    return null;
  }
  const ids = await resolveRecordIds(orgId, { type: input.type, id: input.id });
  if (!ids) return null;
  return { type: input.type, id: ids.id };
}

export async function logAnchoredTimeline(input: {
  type: CrmAnchorType;
  recordId: string;
  roomId: string;
  messageId: string;
  authorName: string | null;
}) {
  const meta = {
    roomId: input.roomId,
    messageId: input.messageId,
    authorName: input.authorName,
  };
  if (input.type === "deal") {
    const deal = await prisma.deal.findFirst({
      where: { id: input.recordId },
      select: { id: true, title: true, contactId: true, number: true },
    });
    if (!deal) return;
    await logEvent({
      type: "TEAM_CHAT_ANCHORED",
      entityType: "DEAL",
      entityId: deal.id,
      entityLabel: deal.title || `Negócio #${deal.number}`,
      dealId: deal.id,
      contactId: deal.contactId,
      meta,
    });
    return;
  }
  if (input.type === "conversation") {
    const conv = await prisma.conversation.findFirst({
      where: { id: input.recordId },
      select: { id: true, number: true, contactId: true },
    });
    if (!conv) return;
    await logEvent({
      type: "TEAM_CHAT_ANCHORED",
      entityType: "CONVERSATION",
      entityId: conv.id,
      entityLabel: `Atendimento #${conv.number}`,
      conversationId: conv.id,
      contactId: conv.contactId,
      meta,
    });
    return;
  }
  const contact = await prisma.contact.findFirst({
    where: { id: input.recordId },
    select: { id: true, name: true, number: true },
  });
  if (!contact) return;
  await logEvent({
    type: "TEAM_CHAT_ANCHORED",
    entityType: "CONTACT",
    entityId: contact.id,
    entityLabel: contact.name || `Contato #${contact.number}`,
    contactId: contact.id,
    meta,
  });
}

export type RecordSearchHit = {
  type: CrmAnchorType;
  id: string;
  number: number | null;
  title: string;
  subtitle: string | null;
  href: string;
};

export async function searchCrmRecords(
  viewer: TeamChatViewer,
  q: string,
  take = 12,
): Promise<{ records: RecordSearchHit[] }> {
  const term = q.trim();
  const user = await loadAccessUser(viewer.userId, viewer.organizationId);
  if (!user) return { records: [] };

  const numeric = term && /^\d+$/.test(term) ? parseInt(term, 10) : null;
  const perType = term ? take : Math.min(4, take);
  const vis = await getVisibilityFilter({
    id: user.id,
    role: user.role,
  });

  const authzUser = {
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  };
  const [canDeal, canConv, canContact] = await Promise.all([
    checkPermission(authzUser, "deal:view"),
    checkPermission(authzUser, "conversation:view"),
    checkPermission(authzUser, "contact:view"),
  ]);

  const hits: RecordSearchHit[] = [];

  if (canDeal) {
    const deals = await prisma.deal.findMany({
      where: {
        AND: [
          vis.dealWhere,
          !term
            ? {}
            : numeric != null
              ? { OR: [{ number: numeric }, { title: { contains: term, mode: "insensitive" } }] }
              : { title: { contains: term, mode: "insensitive" } },
        ],
      },
      take: perType,
      orderBy: { updatedAt: "desc" },
      select: { id: true, number: true, title: true, status: true },
    });
    for (const d of deals) {
      hits.push({
        type: "deal",
        id: d.id,
        number: d.number,
        title: d.title,
        subtitle: STATUS_LABEL[d.status] ?? d.status,
        href: hrefForAnchor("deal", d.number),
      });
    }
  }

  if (canConv) {
    const convs = await prisma.conversation.findMany({
      where: {
        AND: [
          vis.conversationWhere,
          !term
            ? {}
            : numeric != null
              ? { OR: [{ number: numeric }, { contact: { name: { contains: term, mode: "insensitive" } } }] }
              : { contact: { name: { contains: term, mode: "insensitive" } } },
        ],
      },
      take: perType,
      orderBy: { updatedAt: "desc" },
      select: { id: true, number: true, status: true, contact: { select: { name: true } } },
    });
    for (const c of convs) {
      hits.push({
        type: "conversation",
        id: c.id,
        number: c.number,
        title: c.contact?.name || `Atendimento #${c.number}`,
        subtitle: `Atendimento #${c.number}`,
        href: hrefForAnchor("conversation", c.number),
      });
    }
  }

  if (canContact) {
    const contacts = await prisma.contact.findMany({
      where: !term
        ? {}
        : numeric != null
          ? { OR: [{ number: numeric }, { name: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }] }
          : { OR: [{ name: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }] },
      take: perType,
      orderBy: { updatedAt: "desc" },
      select: { id: true, number: true, name: true, phone: true },
    });
    for (const c of contacts) {
      hits.push({
        type: "contact",
        id: c.id,
        number: c.number,
        title: c.name,
        subtitle: c.phone,
        href: hrefForAnchor("contact", c.number),
      });
    }
  }

  return { records: hits.slice(0, term ? take : perType * 3) };
}

export type ChatDestination = {
  roomId: string | null;
  personId: string | null;
  kind: "DM" | "GROUP" | "CHANNEL";
  section: "people" | "groups" | "channels";
  name: string;
  memberCount: number;
  lastMessageAt: string;
};

export function isChannelKind(kind: string): boolean {
  return kind === "CHANNEL" || kind === "GROUP";
}

export function destinationSection(kind: string): ChatDestination["section"] {
  if (kind === "DM") return "people";
  if (kind === "CHANNEL") return "channels";
  return "channels";
}

export async function listShareDestinations(
  viewer: TeamChatViewer,
  q?: string,
): Promise<{ destinations: ChatDestination[] }> {
  const rooms = await prisma.teamChatRoom.findMany({
    where: { members: { some: { userId: viewer.userId } } },
    orderBy: { lastMessageAt: "desc" },
    take: 80,
    include: {
      members: { select: { userId: true, user: { select: { id: true, name: true } } } },
    },
  });

  const term = q?.trim().toLowerCase() ?? "";
  const dests: ChatDestination[] = rooms.map((room) => {
    const others = room.members.filter((m) => m.userId !== viewer.userId);
    const name =
      room.kind === "DM" ? (others[0]?.user.name ?? "Conversa") : (room.name ?? "Canal");
    return {
      roomId: room.id,
      personId: room.kind === "DM" ? others[0]?.userId ?? null : null,
      kind: room.kind as ChatDestination["kind"],
      section: destinationSection(room.kind),
      name,
      memberCount: room.members.length,
      lastMessageAt: room.lastMessageAt.toISOString(),
    };
  });

  const colleagues = await prisma.user.findMany({
    where: {
      organizationId: viewer.organizationId,
      type: "HUMAN",
      isErased: false,
      id: { not: viewer.userId },
    },
    select: { id: true, name: true },
    take: 80,
  });
  const knownPeers = new Set(dests.filter((d) => d.personId).map((d) => d.personId));
  for (const u of colleagues) {
    if (knownPeers.has(u.id)) continue;
    dests.push({
      roomId: null,
      personId: u.id,
      kind: "DM",
      section: "people",
      name: u.name,
      memberCount: 2,
      lastMessageAt: "",
    });
  }

  const filtered = term
    ? dests.filter((d) => d.name.toLowerCase().includes(term))
    : dests;

  filtered.sort((a, b) => {
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return tb - ta;
  });

  return { destinations: filtered.slice(0, 60) };
}

export async function destinationAccessWarning(
  viewer: TeamChatViewer,
  roomIds: string[],
  ref: CrmInternalRef,
): Promise<{
  rooms: Array<{
    roomId: string;
    name: string;
    memberCount: number;
    withoutAccess: number;
  }>;
}> {
  const ids = await resolveRecordIds(viewer.organizationId, ref);
  if (!ids) return { rooms: [] };

  const rooms = await prisma.teamChatRoom.findMany({
    where: {
      id: { in: roomIds },
      members: { some: { userId: viewer.userId } },
    },
    include: {
      members: { select: { userId: true } },
    },
  });

  const userIds = [...new Set(rooms.flatMap((r) => r.members.map((m) => m.userId)))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, role: true, organizationId: true, isSuperAdmin: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  const access = new Map<string, boolean>();
  await Promise.all(
    userIds.map(async (uid) => {
      const u = byId.get(uid);
      if (!u?.organizationId) {
        access.set(uid, false);
        return;
      }
      access.set(
        uid,
        await userCanSeeRecord(
          {
            id: u.id,
            role: u.role as AppUserRole,
            organizationId: u.organizationId,
            isSuperAdmin: u.isSuperAdmin,
          },
          ref.type,
          ids.id,
        ),
      );
    }),
  );

  return {
    rooms: rooms.map((room) => {
      const others = room.members.filter((m) => m.userId !== viewer.userId);
      const without = others.filter((m) => access.get(m.userId) === false).length;
      return {
        roomId: room.id,
        name: room.name ?? "Conversa",
        memberCount: room.members.length,
        withoutAccess: without,
      };
    }),
  };
}

export { parseCrmInternalUrl };
