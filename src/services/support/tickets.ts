/**
 * Serviço do chat interno de suporte (tickets + mensagens).
 *
 * Um usuário abre um ticket (categoria + descrição); o sistema gera um
 * número sequencial, registra a descrição como primeira mensagem e tenta
 * distribuir para um agente do departamento de suporte. Agentes (membros
 * do depto de suporte, ADMIN ou MANAGER) atendem via console próprio.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  publishSupportMessage,
  publishSupportTicketNew,
  publishSupportTicketUpdated,
} from "@/lib/realtime-events";
import { getSupportDepartment, tryAssignTicket } from "./distribution";

export type SupportViewer = {
  userId: string;
  organizationId: string;
  role?: "ADMIN" | "MANAGER" | "MEMBER" | null;
};

const TICKET_SELECT = {
  id: true,
  number: true,
  category: true,
  description: true,
  status: true,
  requesterId: true,
  assignedToId: true,
  departmentId: true,
  lastMessageAt: true,
  requesterUnread: true,
  agentUnread: true,
  createdAt: true,
  resolvedAt: true,
  requester: { select: { id: true, name: true, avatarUrl: true } },
  assignedTo: { select: { id: true, name: true, avatarUrl: true } },
} as const;

/** Um usuário é "agente de suporte" se for ADMIN/MANAGER ou membro do depto de suporte. */
export async function isSupportAgent(viewer: SupportViewer): Promise<boolean> {
  if (viewer.role === "ADMIN" || viewer.role === "MANAGER") return true;
  const dept = await getSupportDepartment(viewer.organizationId);
  if (!dept) return false;
  const member = await prisma.departmentMember.findFirst({
    where: {
      organizationId: viewer.organizationId,
      departmentId: dept.id,
      userId: viewer.userId,
    },
    select: { id: true },
  });
  return !!member;
}

function publishTicketEvent(
  event: "support_ticket_new" | "support_ticket_updated",
  ticket: { id: string; organizationId?: string; requesterId: string; assignedToId: string | null; status: string; number: number },
  organizationId: string,
) {
  const publish =
    event === "support_ticket_new"
      ? publishSupportTicketNew
      : publishSupportTicketUpdated;
  publish({
    organizationId,
    ticketId: ticket.id,
    requesterId: ticket.requesterId,
    assignedToId: ticket.assignedToId,
    status: ticket.status,
    number: ticket.number,
  });
}

export async function createTicket(
  viewer: SupportViewer,
  input: { category: string; description: string },
) {
  const orgId = viewer.organizationId;

  const last = await prisma.supportTicket.aggregate({ _max: { number: true } });
  const number = (last._max.number ?? 0) + 1;

  const created = await prisma.supportTicket.create({
    data: withOrgFromCtx({
      number,
      category: input.category,
      description: input.description,
      status: "PENDING",
      requesterId: viewer.userId,
      lastMessageAt: new Date(),
      agentUnread: 1,
    }),
    select: { id: true },
  });

  // Primeira mensagem = descrição do formulário (autor = solicitante).
  await prisma.supportTicketMessage.create({
    data: withOrgFromCtx({
      ticketId: created.id,
      authorId: viewer.userId,
      authorType: "requester",
      content: input.description,
    }),
  });

  // Distribui (ou mantém em fila).
  const assigned = await tryAssignTicket(orgId, created.id);

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: created.id },
    select: TICKET_SELECT,
  });

  if (ticket) {
    publishTicketEvent("support_ticket_new", { ...ticket, organizationId: orgId }, orgId);
    if (assigned.status === "OPEN") {
      publishTicketEvent("support_ticket_updated", { ...ticket, organizationId: orgId }, orgId);
    }
  }
  return ticket;
}

export async function listTickets(
  viewer: SupportViewer,
  scope: "mine" | "assigned" | "queue" | "all",
) {
  if (scope === "mine") {
    return prisma.supportTicket.findMany({
      where: { requesterId: viewer.userId },
      orderBy: { lastMessageAt: "desc" },
      select: TICKET_SELECT,
    });
  }

  // Escopos de agente
  if (scope === "assigned") {
    return prisma.supportTicket.findMany({
      where: { assignedToId: viewer.userId },
      orderBy: { lastMessageAt: "desc" },
      select: TICKET_SELECT,
    });
  }
  if (scope === "queue") {
    return prisma.supportTicket.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: TICKET_SELECT,
    });
  }
  // all: fila + atribuídos a mim + resolvidos recentes
  return prisma.supportTicket.findMany({
    where: {
      OR: [{ assignedToId: viewer.userId }, { status: "PENDING" }],
    },
    orderBy: { lastMessageAt: "desc" },
    select: TICKET_SELECT,
  });
}

export async function getTicketForViewer(viewer: SupportViewer, ticketId: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: TICKET_SELECT,
  });
  if (!ticket) return { ok: false as const, code: 404 };

  const isRequester = ticket.requesterId === viewer.userId;
  const agent = await isSupportAgent(viewer);
  if (!isRequester && !agent) return { ok: false as const, code: 403 };

  return { ok: true as const, ticket, isRequester, isAgent: agent };
}

export async function listMessages(ticketId: string) {
  return prisma.supportTicketMessage.findMany({
    where: { ticketId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      ticketId: true,
      authorId: true,
      authorType: true,
      content: true,
      createdAt: true,
      author: { select: { id: true, name: true, avatarUrl: true } },
    },
  });
}

export async function sendMessage(
  viewer: SupportViewer,
  ticketId: string,
  content: string,
  asAgent: boolean,
) {
  const orgId = viewer.organizationId;
  const message = await prisma.supportTicketMessage.create({
    data: withOrgFromCtx({
      ticketId,
      authorId: viewer.userId,
      authorType: asAgent ? "agent" : "requester",
      content,
    }),
    select: {
      id: true,
      ticketId: true,
      authorId: true,
      authorType: true,
      content: true,
      createdAt: true,
      author: { select: { id: true, name: true, avatarUrl: true } },
    },
  });

  // Atualiza última atividade + contadores de não-lidas da ponta oposta.
  const updated = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      lastMessageAt: new Date(),
      ...(asAgent
        ? { requesterUnread: { increment: 1 } }
        : { agentUnread: { increment: 1 } }),
      // Se o solicitante responde num ticket resolvido, reabre.
      ...(!asAgent ? { status: "OPEN" as const, resolvedAt: null } : {}),
    },
    select: { requesterId: true, assignedToId: true, number: true, status: true },
  });

  publishSupportMessage({
    organizationId: orgId,
    ticketId,
    requesterId: updated.requesterId,
    assignedToId: updated.assignedToId,
    message,
  });
  return message;
}

/** Auto-atribuição de um ticket em fila por um agente. */
export async function claimTicket(viewer: SupportViewer, ticketId: string) {
  const orgId = viewer.organizationId;
  const dept = await getSupportDepartment(orgId);
  const ticket = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      assignedToId: viewer.userId,
      status: "OPEN",
      departmentId: dept?.id ?? undefined,
    },
    select: TICKET_SELECT,
  });
  publishTicketEvent("support_ticket_updated", { ...ticket, organizationId: orgId }, orgId);
  return ticket;
}

export async function resolveTicket(viewer: SupportViewer, ticketId: string) {
  const orgId = viewer.organizationId;
  const ticket = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: { status: "RESOLVED", resolvedAt: new Date() },
    select: TICKET_SELECT,
  });
  await prisma.supportTicketMessage.create({
    data: withOrgFromCtx({
      ticketId,
      authorId: viewer.userId,
      authorType: "system",
      content: "Ticket marcado como resolvido.",
    }),
  });
  publishTicketEvent("support_ticket_updated", { ...ticket, organizationId: orgId }, orgId);
  return ticket;
}

/** Zera contador de não-lidas para a ponta que abriu o ticket. */
export async function markRead(
  viewer: SupportViewer,
  ticketId: string,
  asAgent: boolean,
) {
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: asAgent ? { agentUnread: 0 } : { requesterUnread: 0 },
  });
}
