/**
 * Work items do WiPO Chat — checklist, ata, pauta, feedback, reunião.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { createActivity, deleteActivity, updateActivity } from "@/services/activities";
import {
  previewLabelForRef,
  resolveAnchorInput,
  resolveCrmCardForViewer,
  type CrmCard,
} from "@/services/team-chat-records";
import {
  publishTeamChatEvent,
  requireMember,
  sendSystemMessageThrottled,
  type TeamChatViewer,
} from "@/services/team-chat";
import {
  workItemSseRoomCandidate,
  workItemSseStakeholders,
  type WorkItemSseOrigin,
} from "@/services/team-chat-work-item-sse";

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

async function resolveWorkItemPublishRoomId(
  item: WorkItemSseOrigin,
): Promise<string | null> {
  const hint = workItemSseRoomCandidate(item);
  if (hint.kind === "room") return hint.roomId;
  if (hint.kind === "lookup_message") {
    const msg = await prisma.teamChatMessage.findFirst({
      where: { id: hint.originId },
      select: { roomId: true },
    });
    return msg?.roomId ?? null;
  }
  if (hint.kind === "lookup_meeting") {
    const meeting = await prisma.teamChatWorkItem.findFirst({
      where: { id: hint.originId },
      select: { roomId: true, originType: true, originId: true },
    });
    if (!meeting) return null;
    const nested = workItemSseRoomCandidate({
      roomId: meeting.roomId,
      originType: meeting.originType,
      originId: meeting.originId,
    });
    if (nested.kind === "room") return nested.roomId;
    if (nested.kind === "lookup_message") {
      const msg = await prisma.teamChatMessage.findFirst({
        where: { id: nested.originId },
        select: { roomId: true },
      });
      return msg?.roomId ?? null;
    }
    return meeting.roomId;
  }
  return null;
}

async function resolveOrgAssignee(assigneeId?: string | null) {
  if (!assigneeId) return { value: null as string | null };
  const user = await prisma.user.findFirst({
    where: { id: assigneeId },
    select: { id: true },
  });
  if (!user) return { error: "Responsável não encontrado.", status: 400 as const };
  return { value: user.id };
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

/** Sem `calendarActivityId`: o SELECT padrão do Prisma quebra o create/list
 *  se a migration do calendário ainda não rodou (P2022 → HTML 500 no proxy). */
const ENTRY_SELECT = {
  id: true,
  text: true,
  assigneeId: true,
  assignee: { select: { name: true } },
  dueAt: true,
  status: true,
  sortOrder: true,
  completedAt: true,
} as const;

const ITEM_SELECT = {
  id: true,
  type: true,
  title: true,
  originType: true,
  originId: true,
  roomId: true,
  visibility: true,
  createdById: true,
  createdBy: { select: { name: true } },
  startsAt: true,
  endsAt: true,
  callUrl: true,
  recurrenceKey: true,
  participantIds: true,
  createdAt: true,
  updatedAt: true,
  anchorType: true,
  anchorId: true,
  entries: {
    orderBy: { sortOrder: "asc" as const },
    select: ENTRY_SELECT,
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

type CalendarHost = {
  id: string;
  type: string;
  title: string;
  createdById: string;
  startsAt: Date | null;
  calendarActivityId: string | null;
  anchorType: string | null;
  anchorId: string | null;
};

type CalendarEntry = {
  id: string;
  text: string;
  assigneeId: string | null;
  dueAt: Date | null;
  status: string;
  completedAt: Date | null;
  calendarActivityId: string | null;
};

function crmLinks(host: Pick<CalendarHost, "anchorType" | "anchorId">) {
  if (host.anchorType === "deal" && host.anchorId) {
    return { dealId: host.anchorId, contactId: null as string | null };
  }
  if (host.anchorType === "contact" && host.anchorId) {
    return { contactId: host.anchorId, dealId: null as string | null };
  }
  return { dealId: null as string | null, contactId: null as string | null };
}

function isMissingCalendarColumn(err: unknown) {
  const code =
    typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
  const msg = err instanceof Error ? err.message : String(err);
  return code === "P2022" || /calendarActivityId/i.test(msg);
}

async function removeCalendarActivity(id: string | null | undefined) {
  if (!id) return;
  try {
    await deleteActivity(id);
  } catch {
    /* já apagada ou invisível no escopo */
  }
}

async function loadCalendarState(id: string) {
  try {
    return await prisma.teamChatWorkItem.findFirst({
      where: { id },
      select: {
        id: true,
        type: true,
        title: true,
        createdById: true,
        startsAt: true,
        calendarActivityId: true,
        anchorType: true,
        anchorId: true,
        entries: {
          select: {
            id: true,
            text: true,
            assigneeId: true,
            dueAt: true,
            status: true,
            completedAt: true,
            calendarActivityId: true,
          },
        },
      },
    });
  } catch (err) {
    if (!isMissingCalendarColumn(err)) {
      console.error("[team-chat] calendar load failed", err);
    }
    return null;
  }
}

async function syncWorkItemCalendar(viewer: TeamChatViewer, item: CalendarHost) {
  const links = crmLinks(item);
  if (item.type !== "meeting" || !item.startsAt) {
    if (item.calendarActivityId) {
      await removeCalendarActivity(item.calendarActivityId);
      await prisma.teamChatWorkItem.update({
        where: { id: item.id },
        data: { calendarActivityId: null },
      });
    }
    return;
  }

  const payload = {
    type: "MEETING" as const,
    title: item.title.trim().slice(0, 200) || "Reunião",
    description: "WiPO Chat",
    scheduledAt: item.startsAt,
    userId: item.createdById,
    createdById: viewer.userId,
    ...links,
  };

  if (item.calendarActivityId) {
    try {
      await updateActivity(item.calendarActivityId, {
        type: payload.type,
        title: payload.title,
        description: payload.description,
        scheduledAt: payload.scheduledAt,
        userId: payload.userId,
        dealId: payload.dealId,
        contactId: payload.contactId,
      });
      return;
    } catch {
      /* recria se o espelho sumiu */
    }
  }

  const created = await createActivity(payload);
  await prisma.teamChatWorkItem.update({
    where: { id: item.id },
    data: { calendarActivityId: created.id },
  });
}

async function syncEntryCalendar(viewer: TeamChatViewer, host: CalendarHost, entry: CalendarEntry) {
  if (!entry.dueAt) {
    if (entry.calendarActivityId) {
      await removeCalendarActivity(entry.calendarActivityId);
      await prisma.teamChatWorkItemEntry.update({
        where: { id: entry.id },
        data: { calendarActivityId: null },
      });
    }
    return;
  }

  const links = crmLinks(host);
  const done = entry.status === "done";
  const payload = {
    type: "TASK" as const,
    title: entry.text.trim().slice(0, 200) || host.title,
    description: `WiPO Chat · ${host.title}`,
    scheduledAt: entry.dueAt,
    completed: done,
    completedAt: done ? entry.completedAt ?? new Date() : null,
    userId: entry.assigneeId ?? host.createdById,
    createdById: viewer.userId,
    ...links,
  };

  if (entry.calendarActivityId) {
    try {
      await updateActivity(entry.calendarActivityId, {
        title: payload.title,
        description: payload.description,
        scheduledAt: payload.scheduledAt,
        completed: payload.completed,
        completedAt: payload.completedAt,
        userId: payload.userId,
        dealId: payload.dealId,
        contactId: payload.contactId,
      });
      return;
    } catch {
      /* recria se o espelho sumiu */
    }
  }

  const created = await createActivity(payload);
  await prisma.teamChatWorkItemEntry.update({
    where: { id: entry.id },
    data: { calendarActivityId: created.id },
  });
}

async function syncWorkItemCalendars(
  viewer: TeamChatViewer,
  item: CalendarHost & { entries: CalendarEntry[] },
) {
  try {
    await syncWorkItemCalendar(viewer, item);
    for (const entry of item.entries) {
      await syncEntryCalendar(viewer, item, entry);
    }
  } catch (err) {
    if (!isMissingCalendarColumn(err)) {
      console.error("[team-chat] calendar sync failed", err);
    }
  }
}

async function syncCalendarsIfReady(
  viewer: TeamChatViewer,
  workItemId: string,
  entries?: CalendarEntry[],
) {
  const host = await loadCalendarState(workItemId);
  if (!host) return;
  await syncWorkItemCalendars(viewer, {
    ...host,
    entries: entries ?? host.entries,
  });
}

async function publishWorkItem(
  organizationId: string,
  roomId: string | null,
  workItem: ShapedWorkItem,
) {
  const { crmCard: _card, ...safe } = workItem;
  const resolvedRoomId = await resolveWorkItemPublishRoomId({
    roomId: roomId ?? workItem.roomId,
    originType: workItem.originType,
    originId: workItem.originId,
  });
  const extra = resolvedRoomId
    ? undefined
    : workItemSseStakeholders(workItem);
  await publishTeamChatEvent(
    "team_chat_work_item_updated",
    organizationId,
    {
      roomId: resolvedRoomId,
      workItemId: workItem.id,
      workItem: { ...safe, crmCard: null },
    },
    extra,
  );
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
      select: {
        entries: {
          where: { status: "open" },
          orderBy: { sortOrder: "asc" },
          select: { text: true, assigneeId: true, dueAt: true },
        },
      },
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
    select: ITEM_SELECT,
  });

  await syncCalendarsIfReady(viewer, created.id);
  const shaped = await shapeWorkItem(created, viewer);
  if (input.roomId && input.postMessage !== false) {
    try {
      const { postWorkItemMessage } = await import("@/services/team-chat");
      await postWorkItemMessage(viewer, input.roomId, created.id, title);
    } catch (err) {
      console.error("[team-chat] post work item message failed", err);
    }
  }
  await publishWorkItem(viewer.organizationId, created.roomId, shaped);
  return { workItem: shaped };
}

export async function getWorkItem(viewer: TeamChatViewer, id: string) {
  const item = await prisma.teamChatWorkItem.findFirst({
    where: { id },
    select: ITEM_SELECT,
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
  const item = await prisma.teamChatWorkItem.findFirst({
    where: { id },
    select: { id: true, roomId: true },
  });
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
    select: ITEM_SELECT,
  });
  await syncCalendarsIfReady(viewer, updated.id);
  const shaped = await shapeWorkItem(updated, viewer);
  await publishWorkItem(viewer.organizationId, updated.roomId, shaped);
  return { workItem: shaped };
}

export async function deleteWorkItem(viewer: TeamChatViewer, id: string) {
  const item = await prisma.teamChatWorkItem.findFirst({
    where: { id },
    select: {
      id: true,
      roomId: true,
      originType: true,
      originId: true,
      createdById: true,
      participantIds: true,
      entries: { select: { assigneeId: true } },
    },
  });
  if (!item) return { error: "Item não encontrado.", status: 404 as const };
  if (item.roomId) {
    const member = await requireMember(viewer, item.roomId);
    if (!member) return { error: "Item não encontrado.", status: 404 as const };
  }
  const calendar = await loadCalendarState(id);
  const activityIds = calendar
    ? [calendar.calendarActivityId, ...calendar.entries.map((entry) => entry.calendarActivityId)].filter(
        (value): value is string => Boolean(value),
      )
    : [];
  for (const activityId of activityIds) {
    await removeCalendarActivity(activityId);
  }
  const resolvedRoomId = await resolveWorkItemPublishRoomId({
    roomId: item.roomId,
    originType: item.originType,
    originId: item.originId,
  });
  const extra = resolvedRoomId ? undefined : workItemSseStakeholders(item);
  await prisma.teamChatWorkItem.delete({ where: { id }, select: { id: true } });
  await publishTeamChatEvent(
    "team_chat_work_item_updated",
    viewer.organizationId,
    {
      roomId: resolvedRoomId,
      workItemId: id,
      deleted: true,
    },
    extra,
  );
  return { ok: true as const, roomId: item.roomId };
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
  const assignee = await resolveOrgAssignee(input.assigneeId);
  if ("error" in assignee) return assignee;
  const max = await prisma.teamChatWorkItemEntry.aggregate({
    where: { workItemId },
    _max: { sortOrder: true },
  });
  await prisma.teamChatWorkItemEntry.create({
    data: withOrgFromCtx({
      workItemId,
      text,
      assigneeId: assignee.value,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      sortOrder: (max._max.sortOrder ?? -1) + 1,
    }),
    select: { id: true },
  });
  await syncCalendarsIfReady(viewer, workItemId);
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
    select: {
      id: true,
      text: true,
      assigneeId: true,
      dueAt: true,
      status: true,
      workItem: { select: { roomId: true, title: true } },
    },
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
  if (input.assigneeId !== undefined) {
    const assignee = await resolveOrgAssignee(input.assigneeId);
    if ("error" in assignee) return assignee;
    data.assigneeId = assignee.value;
  }
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

  await prisma.teamChatWorkItemEntry.update({
    where: { id: entryId },
    data,
    select: { id: true },
  });
  await syncCalendarsIfReady(viewer, workItemId);

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

export async function deleteWorkItemEntry(
  viewer: TeamChatViewer,
  workItemId: string,
  entryId: string,
) {
  const entry = await prisma.teamChatWorkItemEntry.findFirst({
    where: { id: entryId, workItemId },
    select: { id: true, workItem: { select: { roomId: true } } },
  });
  if (!entry) return { error: "Item não encontrado.", status: 404 as const };
  if (entry.workItem.roomId) {
    const member = await requireMember(viewer, entry.workItem.roomId);
    if (!member) return { error: "Item não encontrado.", status: 404 as const };
  }
  const calendar = await loadCalendarState(workItemId);
  const mirrored = calendar?.entries.find((row) => row.id === entryId);
  await removeCalendarActivity(mirrored?.calendarActivityId);
  await prisma.teamChatWorkItemEntry.delete({ where: { id: entryId }, select: { id: true } });
  return getWorkItem(viewer, workItemId);
}

export async function listRoomWorkItems(viewer: TeamChatViewer, roomId: string) {
  const member = await requireMember(viewer, roomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };
  const items = await prisma.teamChatWorkItem.findMany({
    where: { roomId },
    orderBy: { updatedAt: "desc" },
    take: 80,
    select: ITEM_SELECT,
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
    select: ITEM_SELECT,
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
    select: {
      id: true,
      title: true,
      roomId: true,
      visibility: true,
      anchorType: true,
      anchorId: true,
      entries: {
        orderBy: { sortOrder: "asc" },
        select: { text: true, assigneeId: true, dueAt: true },
      },
    },
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
