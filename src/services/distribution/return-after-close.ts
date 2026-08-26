/**
 * Quando a automação encerra e o aluno volta, o ticket novo não pode
 * ir para o 1º atendimento da IA. O consultor que estava no chat
 * anterior continua responsável.
 */

import { prisma } from "@/lib/prisma";
import {
  isAssigneeCurrentlyEligible,
  shouldClearOwnershipOnIneligible,
} from "@/services/distribution/assignee-eligibility";

const RETURN_WINDOW_MS = 24 * 60 * 60 * 1000;

function asRecord(meta: unknown): Record<string, unknown> {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return {};
}

async function lastResolvedConversation(contactId: string) {
  const since = new Date(Date.now() - RETURN_WINDOW_MS);
  return prisma.conversation.findFirst({
    where: {
      contactId,
      status: "RESOLVED",
      closedAt: { gte: since },
    },
    orderBy: [{ closedAt: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
}

async function wasClosedByAutomation(conversationId: string): Promise<boolean> {
  const ev = await prisma.activityEvent.findFirst({
    where: {
      conversationId,
      type: "CONVERSATION_CLOSED",
    },
    orderBy: { occurredAt: "desc" },
    select: { actorType: true, meta: true },
  });
  if (ev) {
    if (ev.actorType === "AUTOMATION") return true;
    if (asRecord(ev.meta).source === "automation") return true;
  }

  const note = await prisma.message.findFirst({
    where: {
      conversationId,
      isPrivate: false,
      OR: [
        { content: { contains: "encerrada por Automa", mode: "insensitive" } },
        {
          content: {
            contains: "encerrada devido a falta de intera",
            mode: "insensitive",
          },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return Boolean(note);
}

async function resolvePreviousHumanOwner(
  contactId: string,
  closed: { assignedToId: string | null; assignedTo: { type: string } | null },
): Promise<string | null> {
  if (closed.assignedToId && closed.assignedTo?.type === "HUMAN") {
    return closed.assignedToId;
  }

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (contact?.assignedToId && contact.assignedTo?.type === "HUMAN") {
    return contact.assignedToId;
  }

  const deal = await prisma.deal.findFirst({
    where: { contactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: {
      ownerId: true,
      owner: { select: { type: true } },
    },
  });
  if (deal?.ownerId && deal.owner?.type === "HUMAN") {
    return deal.ownerId;
  }

  return null;
}

/** Human que deve ficar no ticket novo após encerramento da automação. */
export async function findHumanToKeepAfterAutomationClose(
  contactId: string,
): Promise<string | null> {
  const closed = await lastResolvedConversation(contactId);
  if (!closed) return null;
  if (!(await wasClosedByAutomation(closed.id))) return null;

  const humanId = await resolvePreviousHumanOwner(contactId, closed);
  if (!humanId) return null;

  const stillHuman = await prisma.user.findFirst({
    where: { id: humanId, type: "HUMAN" },
    select: { id: true },
  });
  if (!stillHuman) return null;

  // Offline / fora do expediente: devolver a ele deixaria o aluno parado, então
  // segue o fluxo normal de distribuição. Fila cheia é exceção: o teto barra
  // lead NOVO, e aqui o aluno já é caso dele — mandar para a fila de espera
  // seria pior do que devolver ao consultor que o atendeu.
  const check = await isAssigneeCurrentlyEligible(stillHuman.id);
  if (check.eligible) return stillHuman.id;
  return shouldClearOwnershipOnIneligible(check.reason, check.blockedReasons)
    ? null
    : stillHuman.id;
}

/** Atribui o consultor anterior e impede a IA de assumir. */
export async function keepHumanAfterAutomationClose(args: {
  conversationId: string;
  contactId: string;
}): Promise<string | null> {
  const humanId = await findHumanToKeepAfterAutomationClose(args.contactId);
  if (!humanId) return null;

  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { assignedToId: humanId },
    });
    await tx.contact.update({
      where: { id: args.contactId },
      data: { assignedToId: humanId },
    });
    await tx.deal.updateMany({
      where: { contactId: args.contactId, status: "OPEN" },
      data: { ownerId: humanId },
    });
  });

  return humanId;
}
