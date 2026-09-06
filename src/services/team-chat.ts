/**
 * Chat interno do time — DMs 1:1 e grupos.
 * Isolado da Inbox (leads) e do SupportTicket (helpdesk).
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { sseBus } from "@/lib/sse-bus";
import { extractCrmRefsFromText, stripCrmUrls } from "@/lib/crm-internal-url";
import { getSystemPresenceMap } from "@/services/system-presence";
import {
  logAnchoredTimeline,
  previewLabelForRef,
  resolveAnchorInput,
  resolveCrmCardForViewer,
  type CrmCard,
} from "@/services/team-chat-records";

export type TeamChatAttachmentKind = "image" | "audio" | "video" | "file" | "sticker";

export type TeamChatAttachment = {
  url: string;
  name: string;
  mimeType: string;
  size: number;
  kind: TeamChatAttachmentKind;
  emoji?: string;
};

const USER_SELECT = { id: true, name: true, avatarUrl: true } as const;

const MESSAGE_SELECT = {
  id: true,
  roomId: true,
  authorId: true,
  kind: true,
  content: true,
  pinned: true,
  reactions: true,
  attachments: true,
  createdAt: true,
  author: { select: USER_SELECT },
} as const;

type StoredReaction = { emoji: string; userIds: string[] };

function parseReactions(raw: unknown, viewerId: string) {
  const list = Array.isArray(raw) ? (raw as StoredReaction[]) : [];
  return list
    .filter((r) => r && typeof r.emoji === "string" && Array.isArray(r.userIds))
    .map((r) => ({
      emoji: r.emoji,
      count: r.userIds.length,
      mine: r.userIds.includes(viewerId),
      userIds: r.userIds,
    }))
    .filter((r) => r.count > 0);
}

const ATTACHMENT_KINDS = new Set<TeamChatAttachmentKind>([
  "image",
  "audio",
  "video",
  "file",
  "sticker",
]);

function parseAttachments(raw: unknown): TeamChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamChatAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const kind = a.kind;
    if (typeof kind !== "string" || !ATTACHMENT_KINDS.has(kind as TeamChatAttachmentKind)) continue;
    const name = typeof a.name === "string" ? a.name : "arquivo";
    const mimeType = typeof a.mimeType === "string" ? a.mimeType : "application/octet-stream";
    const url = typeof a.url === "string" ? a.url : "";
    const size = typeof a.size === "number" && Number.isFinite(a.size) ? a.size : 0;
    const emoji = typeof a.emoji === "string" ? a.emoji : undefined;
    out.push({ url, name, mimeType, size, kind: kind as TeamChatAttachmentKind, emoji });
  }
  return out;
}

export type TeamChatMessagePayload = {
  id: string;
  roomId: string;
  authorId: string | null;
  kind: "TEXT" | "SYSTEM";
  content: string;
  displayContent: string;
  pinned: boolean;
  reactions: ReturnType<typeof parseReactions>;
  attachments: TeamChatAttachment[];
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  anchorRef: { type: string; id: string } | null;
  card: CrmCard | null;
  workItemId: string | null;
  forward: {
    id: string;
    type: string;
    excerpt: string;
    note: string;
    fromUserId: string;
    fromUserName: string | null;
    respondedAt: string | null;
    responseNote: string | null;
  } | null;
};

function shapeMessage(
  m: {
    id: string;
    roomId: string;
    authorId: string | null;
    kind: string;
    content: string;
    pinned?: boolean;
    reactions?: unknown;
    attachments?: unknown;
    createdAt: Date;
    author: { id: string; name: string; avatarUrl: string | null } | null;
  },
  viewerId: string,
  extra?: {
    card?: CrmCard | null;
    anchorRef?: { type: string; id: string } | null;
    workItemId?: string | null;
    forward?: TeamChatMessagePayload["forward"];
  },
): TeamChatMessagePayload {
  const hasCard = !!extra?.card || !!extra?.workItemId || !!extra?.forward;
  const rawContent =
    m.kind === "SYSTEM" ? m.content.replace(/\u200b[\s\S]*$/, "").trim() : m.content;
  return {
    id: m.id,
    roomId: m.roomId,
    authorId: m.authorId,
    kind: m.kind as "TEXT" | "SYSTEM",
    content: rawContent,
    displayContent: hasCard && extra?.card ? stripCrmUrls(rawContent) : rawContent,
    pinned: !!m.pinned,
    reactions: parseReactions(m.reactions, viewerId),
    attachments: parseAttachments(m.attachments),
    createdAt: m.createdAt.toISOString(),
    author: m.author,
    anchorRef: extra?.anchorRef ?? null,
    card: extra?.card ?? null,
    workItemId: extra?.workItemId ?? null,
    forward: extra?.forward ?? null,
  };
}

const PREVIEW_MAX = 140;

export type TeamChatViewer = {
  userId: string;
  organizationId: string;
};

function dmKeyFor(a: string, b: string) {
  return [a, b].sort().join(":");
}

function previewOf(content: string) {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

function previewOfPayload(content: string, attachments: TeamChatAttachment[]) {
  const text = previewOf(content);
  if (text) return text;
  const first = attachments[0];
  if (!first) return "";
  if (first.kind === "sticker") return first.emoji || "Figurinha";
  if (first.kind === "audio") return "Áudio";
  if (first.kind === "image") return "Imagem";
  if (first.kind === "video") return "Vídeo";
  return first.name || "Arquivo";
}

export function isOwnedStorageUrl(url: string, organizationId: string) {
  return url.startsWith(`/api/storage/${organizationId}/attachments/`);
}

function publish(
  event:
    | "team_chat_message"
    | "team_chat_room_updated"
    | "team_chat_typing"
    | "team_chat_work_item_updated"
    | "team_chat_forward_updated",
  organizationId: string,
  data: Record<string, unknown>,
) {
  sseBus.publish(event, { organizationId, ...data });
}

export async function signalTyping(viewer: TeamChatViewer, roomId: string, name: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  publish("team_chat_typing", viewer.organizationId, {
    roomId,
    userId: viewer.userId,
    name,
  });
  return { ok: true as const };
}

export async function requireMember(viewer: TeamChatViewer, roomId: string) {
  const member = await prisma.teamChatMember.findFirst({
    where: { roomId, userId: viewer.userId },
    select: { id: true, lastReadAt: true },
  });
  if (!member) return null;
  return member;
}

function shapeRoom(
  room: {
    id: string;
    kind: string;
    name: string | null;
    topic: string | null;
    lastMessageAt: Date;
    lastPreview: string | null;
    createdAt: Date;
    members: {
      userId: string;
      lastReadAt: Date;
      user: { id: string; name: string; avatarUrl: string | null };
    }[];
    _count?: { messages: number };
  },
  viewerId: string,
  unread: number,
  presence?: Map<string, { systemOnline: boolean }>,
) {
  const others = room.members.filter((m) => m.userId !== viewerId);
  const peer = room.kind === "DM" ? others[0]?.user ?? null : null;
  return {
    id: room.id,
    kind: room.kind as "DM" | "GROUP" | "CHANNEL",
    name: room.kind === "DM" ? (peer?.name ?? "Conversa") : (room.name ?? "Canal"),
    topic: room.topic,
    lastMessageAt: room.lastMessageAt.toISOString(),
    lastPreview: room.lastPreview,
    createdAt: room.createdAt.toISOString(),
    unread,
    peer: peer
      ? {
          ...peer,
          systemOnline: presence?.get(peer.id)?.systemOnline ?? false,
        }
      : null,
    members: room.members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      avatarUrl: m.user.avatarUrl,
      systemOnline: presence?.get(m.user.id)?.systemOnline ?? false,
    })),
    memberCount: room.members.length,
  };
}

export async function listRooms(viewer: TeamChatViewer) {
  const rooms = await prisma.teamChatRoom.findMany({
    where: { members: { some: { userId: viewer.userId } } },
    orderBy: { lastMessageAt: "desc" },
    include: {
      members: { select: { userId: true, lastReadAt: true, user: { select: USER_SELECT } } },
    },
  });

  const presence = await getSystemPresenceMap({
    organizationId: viewer.organizationId,
    userIds: [...new Set(rooms.flatMap((r) => r.members.map((m) => m.userId)))],
  }).catch(() => new Map());

  // 1 groupBy em vez de N COUNT (um por sala).
  const roomUnreadFilters: Prisma.TeamChatMessageWhereInput[] = [];
  for (const room of rooms) {
    const mine = room.members.find((m) => m.userId === viewer.userId);
    if (!mine) continue;
    roomUnreadFilters.push({
      roomId: room.id,
      createdAt: { gt: mine.lastReadAt },
    });
  }
  const unreadGroups =
    roomUnreadFilters.length === 0
      ? []
      : await prisma.teamChatMessage.groupBy({
          by: ["roomId"],
          where: {
            AND: [
              { OR: roomUnreadFilters },
              {
                OR: [
                  { authorId: null },
                  { authorId: { not: viewer.userId } },
                ],
              },
              { kind: "TEXT" },
            ],
          },
          _count: { _all: true },
        });
  const unreadMap = new Map(
    unreadGroups.map((g) => [g.roomId, g._count._all] as const),
  );

  return rooms.map((room) =>
    shapeRoom(room, viewer.userId, unreadMap.get(room.id) ?? 0, presence),
  );
}

export async function getRoom(viewer: TeamChatViewer, roomId: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };

  const room = await prisma.teamChatRoom.findFirst({
    where: { id: roomId },
    include: {
      members: { select: { userId: true, lastReadAt: true, user: { select: USER_SELECT } } },
    },
  });
  if (!room) return { error: "Conversa não encontrada.", status: 404 as const };

  const presence = await getSystemPresenceMap({
    organizationId: viewer.organizationId,
    userIds: room.members.map((m) => m.userId),
  }).catch(() => new Map());

  const unread = await prisma.teamChatMessage.count({
    where: {
      roomId,
      createdAt: { gt: member.lastReadAt },
      OR: [{ authorId: null }, { authorId: { not: viewer.userId } }],
      kind: "TEXT",
    },
  });

  return { room: shapeRoom(room, viewer.userId, unread, presence) };
}

export async function createRoom(
  viewer: TeamChatViewer,
  input: { memberIds: string[]; name?: string; topic?: string },
) {
  const unique = [...new Set(input.memberIds.filter((id) => id && id !== viewer.userId))];
  if (unique.length === 0) {
    return { error: "Escolha pelo menos uma pessoa.", status: 400 as const };
  }

  const orgUsers = await prisma.user.findMany({
    where: {
      id: { in: unique },
      organizationId: viewer.organizationId,
      type: "HUMAN",
      isErased: false,
    },
    select: { id: true, name: true },
  });
  if (orgUsers.length !== unique.length) {
    return { error: "Algum colega não pertence à organização.", status: 400 as const };
  }

  const isDm = unique.length === 1 && !input.name?.trim();
  if (isDm) {
    const dmKey = dmKeyFor(viewer.userId, unique[0]);
    const existing = await prisma.teamChatRoom.findFirst({
      where: { dmKey },
      include: {
        members: { select: { userId: true, lastReadAt: true, user: { select: USER_SELECT } } },
      },
    });
    if (existing) {
      return { room: shapeRoom(existing, viewer.userId, 0), created: false };
    }

    let created;
    try {
      created = await prisma.teamChatRoom.create({
      data: withOrgFromCtx({
        kind: "DM",
        dmKey,
        createdById: viewer.userId,
        members: {
          create: [viewer.userId, unique[0]].map((userId) =>
            withOrgFromCtx({ userId }),
          ),
        },
      }),
      include: {
        members: { select: { userId: true, lastReadAt: true, user: { select: USER_SELECT } } },
      },
    });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") {
        const again = await prisma.teamChatRoom.findFirst({
          where: { dmKey },
          include: {
            members: { select: { userId: true, lastReadAt: true, user: { select: USER_SELECT } } },
          },
        });
        if (again) return { room: shapeRoom(again, viewer.userId, 0), created: false };
      }
      throw err;
    }
    publish("team_chat_room_updated", viewer.organizationId, {
      roomId: created.id,
      memberIds: created.members.map((m) => m.userId),
    });
    return { room: shapeRoom(created, viewer.userId, 0), created: true };
  }

  const name = input.name?.trim();
  if (!name) return { error: "Dê um nome ao grupo.", status: 400 as const };
  if (unique.length < 1) return { error: "Grupo precisa de pelo menos um colega.", status: 400 as const };

  const memberIds = [viewer.userId, ...unique];
  const created = await prisma.teamChatRoom.create({
    data: withOrgFromCtx({
      kind: "CHANNEL",
      name,
      topic: input.topic?.trim() || null,
      createdById: viewer.userId,
      members: {
        create: memberIds.map((userId) => withOrgFromCtx({ userId })),
      },
    }),
    include: {
      members: { select: { userId: true, lastReadAt: true, user: { select: USER_SELECT } } },
    },
  });

  const me = await prisma.user.findFirst({
    where: { id: viewer.userId },
    select: { name: true },
  });
  await prisma.teamChatMessage.create({
    data: withOrgFromCtx({
      roomId: created.id,
      authorId: viewer.userId,
      kind: "SYSTEM",
      content: `${me?.name ?? "Alguém"} criou o canal #${name}`,
    }),
  });
  await prisma.teamChatRoom.update({
    where: { id: created.id },
    data: { lastPreview: `${me?.name ?? "Alguém"} criou o canal` },
  });

  publish("team_chat_room_updated", viewer.organizationId, {
    roomId: created.id,
    memberIds,
  });
  return { room: shapeRoom(created, viewer.userId, 0), created: true };
}

export async function addMembers(
  viewer: TeamChatViewer,
  roomId: string,
  memberIds: string[],
) {
  const access = await getRoom(viewer, roomId);
  if ("error" in access) return access;
  if (access.room.kind !== "GROUP" && access.room.kind !== "CHANNEL") {
    return { error: "Só canais e grupos aceitam novos membros.", status: 400 as const };
  }

  const unique = [...new Set(memberIds.filter((id) => id && id !== viewer.userId))];
  const already = new Set(access.room.members.map((m) => m.id));
  const toAdd = unique.filter((id) => !already.has(id));
  if (toAdd.length === 0) return { room: access.room };

  const orgUsers = await prisma.user.findMany({
    where: {
      id: { in: toAdd },
      organizationId: viewer.organizationId,
      type: "HUMAN",
      isErased: false,
    },
    select: { id: true, name: true },
  });
  if (orgUsers.length !== toAdd.length) {
    return { error: "Algum colega não pertence à organização.", status: 400 as const };
  }

  await prisma.teamChatMember.createMany({
    data: toAdd.map((userId) =>
      withOrgFromCtx({ roomId, userId }),
    ),
    skipDuplicates: true,
  });

  const me = await prisma.user.findFirst({
    where: { id: viewer.userId },
    select: { name: true },
  });
  const names = orgUsers.map((u) => u.name).join(", ");
  await prisma.teamChatMessage.create({
    data: withOrgFromCtx({
      roomId,
      authorId: viewer.userId,
      kind: "SYSTEM",
      content: `${me?.name ?? "Alguém"} adicionou ${names}`,
    }),
  });

  publish("team_chat_room_updated", viewer.organizationId, {
    roomId,
    memberIds: [...already, ...toAdd],
  });
  return getRoom(viewer, roomId);
}

export async function listMessages(
  viewer: TeamChatViewer,
  roomId: string,
  opts?: { before?: string; take?: number },
) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };

  const take = Math.min(Math.max(opts?.take ?? 80, 1), 200);
  const rows = await prisma.teamChatMessage.findMany({
    where: {
      roomId,
      ...(opts?.before ? { createdAt: { lt: new Date(opts.before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    select: MESSAGE_SELECT,
  });

  const messageIds = rows.map((m) => m.id);
  const [anchors, forwards] = await Promise.all([
    prisma.teamChatMessageAnchor.findMany({
      where: { messageId: { in: messageIds } },
    }),
    prisma.teamChatMessageForward.findMany({
      where: { destMessageId: { in: messageIds } },
      include: { fromUser: { select: { name: true } } },
    }),
  ]);
  const anchorByMsg = new Map(anchors.map((a) => [a.messageId, a]));
  const forwardByMsg = new Map(
    forwards
      .filter((f) => f.destMessageId)
      .map((f) => [
        f.destMessageId as string,
        {
          id: f.id,
          type: f.type,
          excerpt: f.excerpt,
          note: f.note,
          fromUserId: f.fromUserId,
          fromUserName: f.fromUser?.name ?? null,
          respondedAt: f.respondedAt?.toISOString() ?? null,
          responseNote: f.responseNote,
        },
      ]),
  );

  const messages = [];
  for (const m of rows.reverse()) {
    const extra = await hydrateMessageExtra(viewer, m.id, anchorByMsg.get(m.id), forwardByMsg.get(m.id));
    messages.push(shapeMessage(m, viewer.userId, extra));
  }
  return { messages };
}

async function hydrateMessageExtra(
  viewer: TeamChatViewer,
  messageId: string,
  anchor?: { anchorType: string; anchorId: string } | null,
  forward?: TeamChatMessagePayload["forward"] | null,
) {
  if (!anchor) {
    return { card: null, anchorRef: null, workItemId: null, forward: forward ?? null };
  }
  if (anchor.anchorType === "work_item") {
    return {
      card: null,
      anchorRef: { type: "work_item", id: anchor.anchorId },
      workItemId: anchor.anchorId,
      forward: forward ?? null,
    };
  }
  const card = await resolveCrmCardForViewer(viewer, {
    type: anchor.anchorType as "deal" | "conversation" | "contact",
    id: anchor.anchorId,
  });
  return {
    card,
    anchorRef: { type: anchor.anchorType, id: anchor.anchorId },
    workItemId: null as string | null,
    forward: forward ?? null,
  };
}

export async function sendMessage(
  viewer: TeamChatViewer,
  roomId: string,
  input: {
    content?: string;
    attachments?: TeamChatAttachment[];
    anchor?: { type: string; id: string } | null;
  },
) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };

  const text = (input.content ?? "").trim();
  const attachments = (input.attachments ?? []).slice(0, 8);
  if (!text && attachments.length === 0 && !input.anchor) {
    return { error: "Mensagem vazia.", status: 400 as const };
  }
  if (text.length > 4000) return { error: "Mensagem muito longa.", status: 400 as const };

  for (const att of attachments) {
    if (att.kind === "sticker" && att.emoji && !att.url) continue;
    if (!isOwnedStorageUrl(att.url, viewer.organizationId)) {
      return { error: "Anexo inválido.", status: 400 as const };
    }
  }

  let resolved = input.anchor
    ? await resolveAnchorInput(viewer.organizationId, input.anchor)
    : null;
  if (!resolved) {
    const fromText = extractCrmRefsFromText(text)[0];
    if (fromText) resolved = await resolveAnchorInput(viewer.organizationId, fromText);
  }

  const message = await prisma.teamChatMessage.create({
    data: withOrgFromCtx({
      roomId,
      authorId: viewer.userId,
      kind: "TEXT",
      content: text,
      attachments: attachments as unknown as Prisma.InputJsonValue,
    }),
    select: MESSAGE_SELECT,
  });

  if (resolved) {
    await prisma.teamChatMessageAnchor.create({
      data: withOrgFromCtx({
        messageId: message.id,
        anchorType: resolved.type,
        anchorId: resolved.id,
      }),
    });
    if (resolved.type !== "work_item") {
      void logAnchoredTimeline({
        type: resolved.type,
        recordId: resolved.id,
        roomId,
        messageId: message.id,
        authorName: message.author?.name ?? null,
      });
    }
  }

  let lastPreview = previewOfPayload(text, attachments);
  if (resolved && resolved.type !== "work_item") {
    lastPreview = await previewLabelForRef(viewer.organizationId, {
      type: resolved.type,
      id: resolved.id,
    });
  } else if (resolved?.type === "work_item") {
    lastPreview = text || "Checklist";
  } else {
    const urls = extractCrmRefsFromText(text);
    if (urls[0]) lastPreview = await previewLabelForRef(viewer.organizationId, urls[0]);
  }

  const room = await prisma.teamChatRoom.update({
    where: { id: roomId },
    data: { lastMessageAt: message.createdAt, lastPreview },
    select: { members: { select: { userId: true } } },
  });

  await prisma.teamChatMember.update({
    where: { roomId_userId: { roomId, userId: viewer.userId } },
    data: { lastReadAt: message.createdAt },
  });

  const extra = await hydrateMessageExtra(
    viewer,
    message.id,
    resolved ? { anchorType: resolved.type, anchorId: resolved.id } : null,
    null,
  );
  const payload = shapeMessage(message, viewer.userId, extra);
  const ssePayload = { ...payload, card: null };
  publish("team_chat_message", viewer.organizationId, {
    roomId,
    memberIds: room.members.map((m) => m.userId),
    message: ssePayload,
  });
  return { message: payload };
}

export async function postWorkItemMessage(
  viewer: TeamChatViewer,
  roomId: string,
  workItemId: string,
  title: string,
) {
  return sendMessage(viewer, roomId, {
    content: title,
    anchor: { type: "work_item", id: workItemId },
  });
}

export async function sendSystemMessageThrottled(
  viewer: TeamChatViewer,
  roomId: string,
  content: string,
  throttleKey: string,
  windowMs: number,
) {
  const since = new Date(Date.now() - windowMs);
  const recent = await prisma.teamChatMessage.findFirst({
    where: {
      roomId,
      kind: "SYSTEM",
      content: { contains: throttleKey },
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (recent) return;
  await prisma.teamChatMessage.create({
    data: withOrgFromCtx({
      roomId,
      authorId: viewer.userId,
      kind: "SYSTEM",
      content: `${content}\u200b${throttleKey}`,
    }),
  });
  publish("team_chat_room_updated", viewer.organizationId, { roomId });
}

export async function unifiedTeamChatSearch(viewer: TeamChatViewer, q: string) {
  const term = q.trim();
  if (term.length < 2) return { messages: [], workItems: [], records: [] };
  const { searchCrmRecords } = await import("@/services/team-chat-records");
  const rooms = await prisma.teamChatMember.findMany({
    where: { userId: viewer.userId },
    select: { roomId: true },
  });
  const roomIds = rooms.map((r) => r.roomId);
  const [messages, workItems, records] = await Promise.all([
    prisma.teamChatMessage.findMany({
      where: {
        roomId: { in: roomIds },
        content: { contains: term, mode: "insensitive" },
        kind: "TEXT",
      },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: {
        id: true,
        roomId: true,
        content: true,
        createdAt: true,
        author: { select: { name: true } },
      },
    }),
    prisma.teamChatWorkItem.findMany({
      where: {
        AND: [
          { title: { contains: term, mode: "insensitive" } },
          { OR: [{ roomId: { in: roomIds } }, { createdById: viewer.userId }] },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 15,
      select: { id: true, title: true, type: true, roomId: true },
    }),
    searchCrmRecords(viewer, term, 10),
  ]);
  return {
    messages: messages.map((m) => ({
      id: m.id,
      roomId: m.roomId,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      authorName: m.author?.name ?? null,
    })),
    workItems,
    records: records.records,
  };
}

export async function markRead(viewer: TeamChatViewer, roomId: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  await prisma.teamChatMember.update({
    where: { roomId_userId: { roomId, userId: viewer.userId } },
    data: { lastReadAt: new Date() },
  });
  return { ok: true };
}

function pickPrimaryDepartmentId(
  memberships: { department: { id: string; name: string } }[],
): string | null {
  if (memberships.length === 0) return null;
  const sorted = [...memberships].sort((a, b) => {
    const byName = a.department.name.localeCompare(b.department.name, "pt-BR");
    if (byName !== 0) return byName;
    return a.department.id.localeCompare(b.department.id);
  });
  return sorted[0]!.department.id;
}

export async function listColleagues(viewer: TeamChatViewer) {
  const [users, departments] = await Promise.all([
    prisma.user.findMany({
      where: {
        organizationId: viewer.organizationId,
        type: "HUMAN",
        isErased: false,
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        role: true,
        departmentMemberships: {
          select: { department: { select: { id: true, name: true } } },
        },
      },
    }),
    prisma.department.findMany({
      where: { organizationId: viewer.organizationId },
      select: { id: true, name: true, color: true, icon: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const presence = await getSystemPresenceMap({
    organizationId: viewer.organizationId,
    userIds: users.map((u) => u.id),
  }).catch(() => new Map());

  const colleagues = users.map((u) => {
    const { departmentMemberships, ...person } = u;
    return {
      ...person,
      departmentId: pickPrimaryDepartmentId(departmentMemberships),
      systemOnline: presence.get(u.id)?.systemOnline ?? false,
      lastSeenAt: presence.get(u.id)?.lastSeenAt?.toISOString() ?? null,
    };
  });

  return { colleagues, departments };
}

export async function toggleReaction(
  viewer: TeamChatViewer,
  roomId: string,
  messageId: string,
  emoji: string,
) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const msg = await prisma.teamChatMessage.findFirst({
    where: { id: messageId, roomId },
    select: MESSAGE_SELECT,
  });
  if (!msg) return { error: "Mensagem não encontrada.", status: 404 as const };

  const list = (Array.isArray(msg.reactions) ? msg.reactions : []) as StoredReaction[];
  const next = list.map((r) => ({ emoji: r.emoji, userIds: [...(r.userIds ?? [])] }));
  const idx = next.findIndex((r) => r.emoji === emoji);
  if (idx === -1) {
    next.push({ emoji, userIds: [viewer.userId] });
  } else if (next[idx].userIds.includes(viewer.userId)) {
    next[idx].userIds = next[idx].userIds.filter((id) => id !== viewer.userId);
    if (next[idx].userIds.length === 0) next.splice(idx, 1);
  } else {
    next[idx].userIds.push(viewer.userId);
  }

  const updated = await prisma.teamChatMessage.update({
    where: { id: messageId },
    data: { reactions: next },
    select: MESSAGE_SELECT,
  });
  const extra = await extrasForMessage(viewer, messageId);
  const payload = shapeMessage(updated, viewer.userId, extra);
  publish("team_chat_message", viewer.organizationId, {
    roomId,
    message: { ...payload, card: null },
  });
  return { message: payload };
}

export async function togglePin(
  viewer: TeamChatViewer,
  roomId: string,
  messageId: string,
) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const msg = await prisma.teamChatMessage.findFirst({
    where: { id: messageId, roomId },
    select: { id: true, pinned: true },
  });
  if (!msg) return { error: "Mensagem não encontrada.", status: 404 as const };
  const updated = await prisma.teamChatMessage.update({
    where: { id: messageId },
    data: { pinned: !msg.pinned },
    select: MESSAGE_SELECT,
  });
  const extra = await extrasForMessage(viewer, messageId);
  const payload = shapeMessage(updated, viewer.userId, extra);
  publish("team_chat_message", viewer.organizationId, {
    roomId,
    message: { ...payload, card: null },
  });
  return { message: payload };
}

async function extrasForMessage(viewer: TeamChatViewer, messageId: string) {
  const [anchor, forward] = await Promise.all([
    prisma.teamChatMessageAnchor.findFirst({ where: { messageId } }),
    prisma.teamChatMessageForward.findFirst({
      where: { destMessageId: messageId },
      include: { fromUser: { select: { name: true } } },
    }),
  ]);
  return hydrateMessageExtra(
    viewer,
    messageId,
    anchor,
    forward
      ? {
          id: forward.id,
          type: forward.type,
          excerpt: forward.excerpt,
          note: forward.note,
          fromUserId: forward.fromUserId,
          fromUserName: forward.fromUser?.name ?? null,
          respondedAt: forward.respondedAt?.toISOString() ?? null,
          responseNote: forward.responseNote,
        }
      : null,
  );
}

export async function shareRecordToChat(
  viewer: TeamChatViewer,
  input: {
    type: string;
    id: string;
    roomIds?: string[];
    personIds?: string[];
    content?: string;
  },
) {
  const resolved = await resolveAnchorInput(viewer.organizationId, {
    type: input.type,
    id: input.id,
  });
  if (!resolved || resolved.type === "work_item") {
    return { error: "Registro não encontrado.", status: 404 as const };
  }

  const roomIds = new Set(input.roomIds ?? []);
  for (const personId of input.personIds ?? []) {
    const created = await createRoom(viewer, { memberIds: [personId] });
    if ("error" in created) return created;
    roomIds.add(created.room.id);
  }
  if (roomIds.size === 0) return { error: "Escolha um destino.", status: 400 as const };

  const messages = [];
  for (const roomId of roomIds) {
    const sent = await sendMessage(viewer, roomId, {
      content: input.content ?? "",
      anchor: { type: resolved.type, id: resolved.id },
    });
    if ("error" in sent) return sent;
    messages.push(sent.message);
  }
  return { messages, count: messages.length };
}

function shapeNote(n: { id: string; content: string; pinned: boolean; createdAt: Date }) {
  return {
    id: n.id,
    text: n.content,
    pinned: n.pinned,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function listNotes(viewer: TeamChatViewer, roomId: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const notes = await prisma.teamChatNote.findMany({
    where: { roomId, authorId: viewer.userId },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
  });
  return { notes: notes.map(shapeNote) };
}

export async function addNote(viewer: TeamChatViewer, roomId: string, content: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const text = content.trim();
  if (!text) return { error: "Nota vazia.", status: 400 as const };
  const note = await prisma.teamChatNote.create({
    data: withOrgFromCtx({
      roomId,
      authorId: viewer.userId,
      content: text,
    }),
  });
  return { note: shapeNote(note) };
}

export async function toggleNotePin(viewer: TeamChatViewer, noteId: string) {
  const note = await prisma.teamChatNote.findFirst({
    where: { id: noteId, authorId: viewer.userId },
  });
  if (!note) return { error: "Nota não encontrada.", status: 404 as const };
  const updated = await prisma.teamChatNote.update({
    where: { id: noteId },
    data: { pinned: !note.pinned },
  });
  return { note: shapeNote(updated) };
}

export async function deleteNote(viewer: TeamChatViewer, noteId: string) {
  const note = await prisma.teamChatNote.findFirst({
    where: { id: noteId, authorId: viewer.userId },
    select: { id: true },
  });
  if (!note) return { error: "Nota não encontrada.", status: 404 as const };
  await prisma.teamChatNote.delete({ where: { id: noteId } });
  return { ok: true };
}
