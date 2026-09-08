/**
 * Encaminhar com anotação (Fase 5) e pauta de 1:1.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { sseBus } from "@/lib/sse-bus";
import { isChannelKind } from "@/services/team-chat-records";
import {
  createRoom,
  requireMember,
  sendMessage,
  type TeamChatViewer,
} from "@/services/team-chat";

export const FORWARD_TYPES = ["correcao", "atencao", "reconhecimento"] as const;
export type ForwardType = (typeof FORWARD_TYPES)[number];

export type ShapedForward = {
  id: string;
  sourceMessageId: string;
  destMessageId: string | null;
  destRoomId: string;
  excerpt: string;
  note: string;
  type: ForwardType;
  fromUserId: string;
  fromUserName: string | null;
  createdAt: string;
  respondedAt: string | null;
  responseNote: string | null;
};

function shapeForward(f: {
  id: string;
  sourceMessageId: string;
  destMessageId: string | null;
  destRoomId: string;
  excerpt: string;
  note: string;
  type: string;
  fromUserId: string;
  fromUser: { name: string } | null;
  createdAt: Date;
  respondedAt: Date | null;
  responseNote: string | null;
}): ShapedForward {
  return {
    id: f.id,
    sourceMessageId: f.sourceMessageId,
    destMessageId: f.destMessageId,
    destRoomId: f.destRoomId,
    excerpt: f.excerpt,
    note: f.note,
    type: f.type as ForwardType,
    fromUserId: f.fromUserId,
    fromUserName: f.fromUser?.name ?? null,
    createdAt: f.createdAt.toISOString(),
    respondedAt: f.respondedAt?.toISOString() ?? null,
    responseNote: f.responseNote,
  };
}

export async function forwardWithAnnotation(
  viewer: TeamChatViewer,
  input: {
    sourceRoomId: string;
    sourceMessageId: string;
    excerpt: string;
    note: string;
    type: ForwardType;
    destRoomId?: string;
    destPersonId?: string;
  },
) {
  const member = await requireMember(viewer, input.sourceRoomId);
  if (!member) return { error: "Conversa não encontrada.", status: 404 as const };

  const note = input.note.trim();
  if (!note) return { error: "A anotação é obrigatória.", status: 400 as const };
  const excerpt = input.excerpt.trim();
  if (!excerpt) return { error: "Selecione o trecho.", status: 400 as const };

  const source = await prisma.teamChatMessage.findFirst({
    where: { id: input.sourceMessageId, roomId: input.sourceRoomId },
    select: { id: true, content: true },
  });
  if (!source) return { error: "Mensagem não encontrada.", status: 404 as const };

  let destRoomId = input.destRoomId ?? null;
  if (!destRoomId && input.destPersonId) {
    const created = await createRoom(viewer, { memberIds: [input.destPersonId] });
    if ("error" in created) return created;
    destRoomId = created.room.id;
  }
  if (!destRoomId) return { error: "Escolha um destino.", status: 400 as const };

  const destMember = await requireMember(viewer, destRoomId);
  if (!destMember) return { error: "Destino não encontrado.", status: 404 as const };

  const destRoom = await prisma.teamChatRoom.findFirst({
    where: { id: destRoomId },
    select: { kind: true },
  });
  if (!destRoom) return { error: "Destino não encontrado.", status: 404 as const };
  if (input.type === "correcao" && isChannelKind(destRoom.kind)) {
    return { error: "Correção não pode ser enviada a um canal.", status: 400 as const };
  }

  const typeLabel =
    input.type === "correcao" ? "Correção" : input.type === "atencao" ? "Atenção" : "Reconhecimento";
  const content = `${typeLabel}\n\n> ${excerpt.replace(/\n/g, " ").slice(0, 400)}\n\n${note}`;

  const sent = await sendMessage(viewer, destRoomId, { content });
  if ("error" in sent) return sent;

  const row = await prisma.teamChatMessageForward.create({
    data: withOrgFromCtx({
      sourceMessageId: source.id,
      destMessageId: sent.message.id,
      excerpt,
      note,
      type: input.type,
      fromUserId: viewer.userId,
      destRoomId,
    }),
    include: { fromUser: { select: { name: true } } },
  });

  const shaped = shapeForward(row);
  sseBus.publish("team_chat_forward_updated", {
    organizationId: viewer.organizationId,
    roomId: destRoomId,
    forward: shaped,
  });
  return { forward: shaped, message: sent.message };
}

export async function respondForward(
  viewer: TeamChatViewer,
  forwardId: string,
  responseNote: string,
) {
  const row = await prisma.teamChatMessageForward.findFirst({
    where: { id: forwardId },
    include: { fromUser: { select: { name: true } } },
  });
  if (!row) return { error: "Encaminhamento não encontrado.", status: 404 as const };
  const member = await requireMember(viewer, row.destRoomId);
  if (!member) return { error: "Encaminhamento não encontrado.", status: 404 as const };
  if (row.fromUserId === viewer.userId) {
    return { error: "Quem recebe marca como ajustado.", status: 400 as const };
  }
  if (row.respondedAt) return { forward: shapeForward(row) };

  const updated = await prisma.teamChatMessageForward.update({
    where: { id: forwardId },
    data: {
      respondedAt: new Date(),
      responseNote: responseNote.trim() || "Ajustado",
      respondedById: viewer.userId,
    },
    include: { fromUser: { select: { name: true } } },
  });

  const me = await prisma.user.findFirst({
    where: { id: viewer.userId },
    select: { name: true },
  });
  await sendMessage(viewer, row.destRoomId, {
    content: `${me?.name ?? "Alguém"} marcou como ajustado${
      responseNote.trim() ? `: ${responseNote.trim()}` : "."
    }`,
  });

  const shaped = shapeForward(updated);
  sseBus.publish("team_chat_forward_updated", {
    organizationId: viewer.organizationId,
    roomId: row.destRoomId,
    forward: shaped,
  });
  return { forward: shaped };
}

export async function getOneOnOne(viewer: TeamChatViewer, peerId: string) {
  const dmKey = [viewer.userId, peerId].sort().join(":");
  const room = await prisma.teamChatRoom.findFirst({
    where: { dmKey },
    select: { id: true },
  });

  const forwards = await prisma.teamChatMessageForward.findMany({
    where: {
      OR: [
        { fromUserId: viewer.userId, destRoomId: room?.id ?? "__none__" },
        { fromUserId: peerId, destRoomId: room?.id ?? "__none__" },
        {
          AND: [
            { destRoomId: room?.id ?? "__none__" },
            { OR: [{ fromUserId: viewer.userId }, { fromUserId: peerId }] },
          ],
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    include: { fromUser: { select: { name: true } } },
  });

  const openItems = await prisma.teamChatWorkItemEntry.findMany({
    where: {
      assigneeId: peerId,
      status: "open",
    },
    orderBy: { dueAt: "asc" },
    take: 40,
    include: {
      workItem: { select: { id: true, title: true, type: true } },
    },
  });

  const now = new Date();
  return {
    roomId: room?.id ?? null,
    forwards: forwards.map(shapeForward),
    openEntries: openItems.map((e) => ({
      id: e.id,
      workItemId: e.workItemId,
      text: e.text,
      dueAt: e.dueAt?.toISOString() ?? null,
      overdue: e.dueAt ? e.dueAt < now : false,
      workItemTitle: e.workItem.title,
      workItemType: e.workItem.type,
    })),
  };
}

export async function forwardsForMessages(messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, ShapedForward>();
  const rows = await prisma.teamChatMessageForward.findMany({
    where: { destMessageId: { in: messageIds } },
    include: { fromUser: { select: { name: true } } },
  });
  const map = new Map<string, ShapedForward>();
  for (const r of rows) {
    if (r.destMessageId) map.set(r.destMessageId, shapeForward(r));
  }
  return map;
}
