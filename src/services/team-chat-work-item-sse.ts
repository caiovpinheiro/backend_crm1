/**
 * Resolução de sala/audiência para SSE de work item.
 * Sem I/O: o publisher faz o lookup de mensagem/reunião quando o candidate pede.
 */

export type WorkItemSseOrigin = {
  roomId: string | null;
  originType: string;
  originId: string;
};

export function workItemSseRoomCandidate(
  item: WorkItemSseOrigin,
):
  | { kind: "room"; roomId: string }
  | { kind: "lookup_message"; originId: string }
  | { kind: "lookup_meeting"; originId: string }
  | { kind: "none" } {
  if (item.roomId) return { kind: "room", roomId: item.roomId };
  if (item.originType === "room" && item.originId) {
    return { kind: "room", roomId: item.originId };
  }
  if (item.originType === "message" && item.originId) {
    return { kind: "lookup_message", originId: item.originId };
  }
  if (item.originType === "meeting" && item.originId) {
    return { kind: "lookup_meeting", originId: item.originId };
  }
  return { kind: "none" };
}

export function workItemSseStakeholders(item: {
  createdById: string;
  participantIds: unknown;
  entries?: { assigneeId: string | null }[];
}): string[] {
  const fromList = Array.isArray(item.participantIds)
    ? item.participantIds.filter((id): id is string => typeof id === "string")
    : [];
  const ids = [item.createdById, ...fromList];
  for (const entry of item.entries ?? []) {
    if (entry.assigneeId) ids.push(entry.assigneeId);
  }
  return [...new Set(ids.filter(Boolean))];
}
