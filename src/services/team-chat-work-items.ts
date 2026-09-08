/**
 * Work items do WiPO Chat — checklist, ata, pauta, feedback, reunião.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { sseBus } from "@/lib/sse-bus";
import {
  previewLabelForRef,
  resolveAnchorInput,
  resolveCrmCardForViewer,
  type CrmCard,
} from "@/services/team-chat-records";
import {
  requireMember,
  sendSystemMessageThrottled,
  type TeamChatViewer,
} from "@/services/team-chat";

export const WORK_ITEM_TYPES = ["checklist", "ata", "pauta", "feedback", "meeting"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export type WorkItemEntryInput = {
  text: string;
  assigneeId?: string | null;
  dueAt?: string | null;
};

export type ShapedWorkItem = {
  id: string;
  type: WorkItemType;
  title: string;
  originType: string;
  originId: string;
  roomId: string | null;
  visibility: string;
  createdById: string;
  createdByName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  callUrl: string | null;
  recurrenceKey: string | null;
  participantIds: string[];
  createdAt: string;
  done: number;
  total: number;
  entries: ShapedEntry[];
  crmCard: CrmCard | null;
  originLabel: string | null;
};

export type ShapedEntry = {
  id: string;
  text: string;
  assigneeId: string | null;
  assigneeName: string | null;
  dueAt: string | null;
  status: "open" | "done";
  sortOrder: number;
  completedAt: string | null;
};

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function shapeEntry(e: {
  id: string;
  text: string;
  assigneeId: string | null;
  assignee: { name: string } | null;
  dueAt: Date | null;
  status: string;
  sortOrder: number;
  completedAt: Date | null;
}): ShapedEntry {
  return {
    id: e.id,
    text: e.text,
    assigneeId: e.assigneeId,
    assigneeName: e.assignee?.name ?? null,
    dueAt: e.dueAt?.toISOString() ?? null,
    status: e.status === "done" ? "done" : "open",
    sortOrder: e.sortOrder,
    completedAt: e.completedAt?.toISOString() ?? null,
  };
}

const ITEM_INCLUDE = {
  createdBy: { select: { name: true } },
  entries: {
    orderBy: { sortOrder: "asc" as const },
    include: { assignee: { select: { name: true } } },
  },
} as const;

async function shapeWorkItem(
  item: {
    id: string;
    type: string;
    title: string;
    originType: string;
    originId: string;
    roomId: string | null;
    visibility: string;
    createdById: string;
    createdBy: { name: string } | null;
    startsAt: Date | null;
    endsAt: Date | null;
    callUrl: string | null;
    recurrenceKey: string | null;
    participantIds: unknown;
    createdAt: Date;
    anchorType: string | null;
    anchorId: string | null;
    entries: Parameters<typeof shapeEntry>[0][];
  },
  viewer: TeamChatViewer,
): Promise<ShapedWorkItem> {
  const entries = item.entries.map(shapeEntry);
  const done = entries.filter((e) => e.status === "done").length;
  let crmCard: CrmCard | null = null;
  if (item.anchorType && item.anchorId && item.anchorType !== "work_item") {
    crmCard = await resolveCrmCardForViewer(viewer, {
      type: item.anchorType as "deal" | "conversation" | "contact",
      id: item.anchorId,
    });
  }
  let originLabel: string | null = null;
  if (item.roomId) {
    const room = await prisma.teamChatRoom.findFirst({
      where: { id: item.roomId },
      select: { kind: true, name: true },
    });
    originLabel = room?.kind === "DM" ? "Conversa direta" : `#${room?.name ?? "canal"}`;
  }
  return {
    id: item.id,
    type: item.type as WorkItemType,
    title: item.title,
    originType: item.originType,
    originId: item.originId,
    roomId: item.roomId,
    visibility: item.visibility,
    createdById: item.createdById,
    createdByName: item.createdBy?.name ?? null,
    startsAt: item.startsAt?.toISOString() ?? null,
    endsAt: item.endsAt?.toISOString() ?? null,
    callUrl: item.callUrl,
    recurrenceKey: item.recurrenceKey,
    participantIds: parseIds(item.participantIds),
    createdAt: item.createdAt.toISOString(),
    done,
    total: entries.length,
    entries,
    crmCard,
    originLabel,
  };
}

function canSeeWorkItem(
  item: { visibility: string; createdById: string; participantIds: unknown; entries: { assigneeId: string | null }[] },
  viewerId: string,
): boolean {
  if (item.visibility === "privado") return item.createdById === viewerId;
  if (item.visibility === "participantes") {
    const ids = new Set(parseIds(item.participantIds));
    ids.add(item.createdById);
    for (const e of item.entries) if (e.assigneeId) ids.add(e.assigneeId);
    return ids.has(viewerId);
  }
  return true;
}

function publishWorkItem(organizationId: string, roomId: string | null, workItem: ShapedWorkItem) {
  // Sem crmCard: o preview é resolvido por leitor no GET.
  const { crmCard: _card, ...safe } = workItem;
  sseBus.publish("team_chat_work_item_updated", {
    organizationId,
    roomId,
    workItemId: workItem.id,
    workItem: { ...safe, crmCard: null },
  });
}

export function extractEntriesFromText(raw: string): { title: string; entries: WorkItemEntryInput[] } {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items: WorkItemEntryInput[] = [];
  let title = "Checklist";
  for (const line of lines) {
    const m = line.match(/^(?:[-*•]|\d+[.)]|\[(?: |x|X)\])\s+(.*)$/);
    if (m?.[1]) {
      items.push({ text: m[1].replace(/^\[(?: |x|X)\]\s*/, "").trim() });
    } else if (items.length === 0 && line.length < 80) {
      title = line.replace(/^#+\s*/, "");
    } else {
      items.push({ text: line });
    }
  }
  return { title, entries: items.slice(0, 40) };
}

export async function createWorkItem(
  viewer: TeamChatViewer,
  input: {
    type: WorkItemType;
    title: string;
    originType: "room" | "meeting" | "message";
    originId: string;
    roomId?: string | null;
    visibility?: "canal" | "privado" | "participantes";
    anchor?: { type: string; id: string } | null;
    entries?: WorkItemEntryInput[];
    startsAt?: string | null;
    endsAt?: string | null;
    callUrl?: string | null;
    recurrenceKey?: string | null;
    participantIds?: string[];
    postMessage?: boolean;
  },
) {
  if (input.roomId) {
    const member = await requireMember(viewer, input.roomId);
    if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  }

  const title = input.title.trim();
  if (!title) return { error: "Dê um título.", status: 400 as const };

  const anchor = input.anchor ? await resolveAnchorInput(viewer.organizationId, input.anchor) : null;
  const entries = (input.entries ?? []).filter((e) => e.text.trim()).slice(0, 40);

  let carry: WorkItemEntryInput[] = [];
  if (input.type === "meeting" && input.recurrenceKey) {
    const prev = await prisma.teamChatWorkItem.findFirst({
      where: { recurrenceKey: input.recurrenceKey, type: "meeting" },
      orderBy: { createdAt: "desc" },
      include: { entries: { where: { status: "open" }, orderBy: { sortOrder: "asc" } } },
    });
    if (prev) {
      carry = prev.entries.map((e) => ({
        text: e.text,
        assigneeId: e.assigneeId,
        dueAt: e.dueAt?.toISOString() ?? null,
      }));
    }
  }

  const merged = [...entries, ...carry.filter((c) => !entries.some((e) => e.text === c.text))];

  const created = await prisma.teamChatWorkItem.create({
    data: withOrgFromCtx({
      type: input.type,
      title,
      originType: input.originType,
      originId: input.originId,
      roomId: input.roomId ?? (input.originType === "room" ? input.originId : null),
      visibility: input.visibility ?? "canal",
      createdById: viewer.userId,
      anchorType: anchor && anchor.type !== "work_item" ? anchor.type : null,
      anchorId: anchor && anchor.type !== "work_item" ? anchor.id : null,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      callUrl: input.callUrl?.trim() || null,
      recurrenceKey: input.recurrenceKey?.trim() || null,
      participantIds: input.participantIds ?? [],
      entries: {
        create: merged.map((e, i) =>
          withOrgFromCtx({
            text: e.text.trim(),
            assigneeId: e.assigneeId || null,
            dueAt: e.dueAt ? new Date(e.dueAt) : null,
            sortOrder: i,
          }),
        ),
      },
    }),
    include: ITEM_INCLUDE,
  });

  const shaped = await shapeWorkItem(created, viewer);
  if (input.roomId && input.postMessage !== false) {
    const { postWorkItemMessage } = await import("@/services/team-chat");
    await postWorkItemMessage(viewer, input.roomId, created.id, title);
  }
  publishWorkItem(viewer.organizationId, created.roomId, shaped);
  return { workItem: shaped };
}

export async function getWorkItem(viewer: TeamChatViewer, id: string) {
  const item = await prisma.teamChatWorkItem.findFirst({
    where: { id },
    include: ITEM_INCLUDE,
  });
  if (!item) return { error: "Item não encontrado.", status: 404 as const };
  if (item.roomId) {
    const member = await requireMember(viewer, item.roomId);
    if (!member && item.createdById !== viewer.userId) {
      return { error: "Item não encontrado.", status: 404 as const };
    }
  }
  if (!canSeeWorkItem(item, viewer.userId)) {
    return { error: "Registro restrito.", status: 403 as const };
  }
  return { workItem: await shapeWorkItem(item, viewer) };
}

export async function updateWorkItem(
  viewer: TeamChatViewer,
  id: string,
  input: {
    title?: string;
    anchor?: { type: string; id: string } | null;
    startsAt?: string | null;
    endsAt?: string | null;
    callUrl?: string | null;
    participantIds?: string[];
  },
) {
  const item = await prisma.teamChatWorkItem.findFirst({ where: { id } });
  if (!item) return { error: "Item não encontrado.", status: 404 as const };
  if (item.roomId) {
    const member = await requireMember(viewer, item.roomId);
    if (!member) return { error: "Item não encontrado.", status: 404 as const };
  }

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.startsAt !== undefined) data.startsAt = input.startsAt ? new Date(input.startsAt) : null;
  if (input.endsAt !== undefined) data.endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (input.callUrl !== undefined) data.callUrl = input.callUrl?.trim() || null;
  if (input.participantIds) data.participantIds = input.participantIds;
  if (input.anchor !== undefined) {
    if (input.anchor === null) {
      data.anchorType = null;
      data.anchorId = null;
    } else {
      const anchor = await resolveAnchorInput(viewer.organizationId, input.anchor);
      if (anchor && anchor.type !== "work_item") {
        data.anchorType = anchor.type;
        data.anchorId = anchor.id;
      }
    }
  }

  const updated = await prisma.teamChatWorkItem.update({
    where: { id },
    data,
    include: ITEM_INCLUDE,
  });
  const shaped = await shapeWorkItem(updated, viewer);
  publishWorkItem(viewer.organizationId, updated.roomId, shaped);
  return { workItem: shaped };
}

export async function addWorkItemEntry(
  viewer: TeamChatViewer,
  workItemId: string,
  input: WorkItemEntryInput,
) {
  const item = await prisma.teamChatWorkItem.findFirst({
    where: { id: workItemId },
    select: { id: true, roomId: true },
  });
  if (!item) return { error: "Item não encontrado.", status: 404 as const };
  if (item.roomId) {
    const member = await requireMember(viewer, item.roomId);
    if (!member) return { error: "Item não encontrado.", status: 404 as const };
  }
  const text = input.text.trim();
  if (!text) return { error: "Texto vazio.", status: 400 as const };
  const max = await prisma.teamChatWorkItemEntry.aggregate({
    where: { workItemId },
    _max: { sortOrder: true },
  });
  await prisma.teamChatWorkItemEntry.create({
    data: withOrgFromCtx({
      workItemId,
      text,
      assigneeId: input.assigneeId || null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      sortOrder: (max._max.sortOrder ?? -1) + 1,
    }),
  });
  return getWorkItem(viewer, workItemId);
}

export async function updateWorkItemEntry(
  viewer: TeamChatViewer,
  workItemId: string,
  entryId: string,
  input: {
    text?: string;
    assigneeId?: string | null;
    dueAt?: string | null;
    status?: "open" | "done";
  },
) {
  const entry = await prisma.teamChatWorkItemEntry.findFirst({
    where: { id: entryId, workItemId },
    include: { workItem: { select: { roomId: true, title: true } } },
  });
  if (!entry) return { error: "Item não encontrado.", status: 404 as const };
  if (entry.workItem.roomId) {
    const member = await requireMember(viewer, entry.workItem.roomId);
    if (!member) return { error: "Item não encontrado.", status: 404 as const };
  }

  await prisma.teamChatWorkItemEntryRevision.create({
    data: withOrgFromCtx({
      entryId,
      changedById: viewer.userId,
      snapshot: {
        text: entry.text,
        assigneeId: entry.assigneeId,
        dueAt: entry.dueAt?.toISOString() ?? null,
        status: entry.status,
      },
    }),
  });

  const data: Record<string, unknown> = {};
  if (input.text !== undefined) data.text = input.text.trim();
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.status === "done") {
    data.status = "done";
    data.completedAt = new Date();
    data.completedById = viewer.userId;
  } else if (input.status === "open") {
    data.status = "open";
    data.completedAt = null;
    data.completedById = null;
  }

  await prisma.teamChatWorkItemEntry.update({ where: { id: entryId }, data });

  if (input.status === "done" && entry.workItem.roomId) {
    const me = await prisma.user.findFirst({
      where: { id: viewer.userId },
      select: { name: true },
    });
    await sendSystemMessageThrottled(
      viewer,
      entry.workItem.roomId,
      `${me?.name ?? "Alguém"} concluiu 1 item em ${entry.workItem.title}`,
      `wi:${workItemId}`,
      3 * 60 * 1000,
    );
  }

  return getWorkItem(viewer, workItemId);
}

export async function listRoomWorkItems(viewer: TeamChatViewer, roomId: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const items = await prisma.teamChatWorkItem.findMany({
    where: { roomId },
    orderBy: { updatedAt: "desc" },
    take: 80,
    include: ITEM_INCLUDE,
  });
  const shaped = [];
  for (const item of items) {
    if (!canSeeWorkItem(item, viewer.userId)) continue;
    shaped.push(await shapeWorkItem(item, viewer));
  }
  return { items: shaped };
}

export async function listMyWorkItems(viewer: TeamChatViewer) {
  const items = await prisma.teamChatWorkItem.findMany({
    where: {
      OR: [
        { createdById: viewer.userId },
        { entries: { some: { assigneeId: viewer.userId, status: "open" } } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 80,
    include: ITEM_INCLUDE,
  });
  const shaped = [];
  for (const item of items) {
    if (!canSeeWorkItem(item, viewer.userId)) continue;
    shaped.push(await shapeWorkItem(item, viewer));
  }
  return { items: shaped };
}

export async function generateChecklistFromMeeting(viewer: TeamChatViewer, meetingId: string) {
  const meeting = await prisma.teamChatWorkItem.findFirst({
    where: { id: meetingId, type: "meeting" },
    include: { entries: { orderBy: { sortOrder: "asc" } } },
  });
  if (!meeting) return { error: "Reunião não encontrada.", status: 404 as const };
  return createWorkItem(viewer, {
    type: "checklist",
    title: `Ata · ${meeting.title}`,
    originType: "meeting",
    originId: meeting.id,
    roomId: meeting.roomId,
    visibility: meeting.visibility as "canal" | "privado" | "participantes",
    anchor:
      meeting.anchorType && meeting.anchorId
        ? { type: meeting.anchorType, id: meeting.anchorId }
        : null,
    entries: meeting.entries.map((e) => ({
      text: e.text,
      assigneeId: e.assigneeId,
      dueAt: e.dueAt?.toISOString() ?? null,
    })),
  });
}

export async function createChecklistFromMessage(
  viewer: TeamChatViewer,
  roomId: string,
  messageId: string,
  input: { title?: string; entries?: WorkItemEntryInput[]; anchor?: { type: string; id: string } | null },
) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const msg = await prisma.teamChatMessage.findFirst({
    where: { id: messageId, roomId },
    select: { id: true, content: true },
  });
  if (!msg) return { error: "Mensagem não encontrada.", status: 404 as const };
  const extracted = extractEntriesFromText(msg.content);
  return createWorkItem(viewer, {
    type: "checklist",
    title: input.title?.trim() || extracted.title,
    originType: "message",
    originId: msg.id,
    roomId,
    entries: input.entries ?? extracted.entries,
    anchor: input.anchor,
  });
}

export { previewLabelForRef };
