/**
 * Gravação da agenda pelo motor (turno do agente). Usa o `prisma` com escopo
 * da org; o worker (cross-tenant) tem as próprias consultas.
 * Nenhum domínio de cliente.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { scheduledKey } from "./agenda";

type ScheduledSendDelegate = {
  updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
};

function store(): ScheduledSendDelegate {
  return (prisma as unknown as { aIV2ScheduledSend: ScheduledSendDelegate }).aIV2ScheduledSend;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Cancela a retomada pendente da conversa (a nova substitui; o cliente desistiu). */
export async function cancelOpenScheduledSends(conversationId: string, outcome: string): Promise<number> {
  const res = await store().updateMany({
    where: { conversationId, kind: "scheduled", status: "PENDING" },
    data: { status: "CANCELLED", outcome, cancelledAt: new Date() },
  });
  return res.count;
}

/**
 * Grava a retomada. Uma pendente por conversa: a anterior vira `superseded`.
 * O índice único parcial do banco barra duas abertas ao mesmo tempo (turnos
 * simultâneos, ou a anterior sendo enviada agora): aí não grava.
 */
export async function createScheduledSend(args: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  agentId: string;
  agentUserId: string;
  dealId: string | null;
  dueAt: Date;
  requestedAt: Date;
  reason: string;
  resumeContext: string;
  turnKey: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  let dealStageIdAtCreate: string | null = null;
  if (args.dealId) {
    const deal = await prisma.deal.findUnique({ where: { id: args.dealId }, select: { stageId: true } }).catch(() => null);
    dealStageIdAtCreate = deal?.stageId ?? null;
  }
  await cancelOpenScheduledSends(args.conversationId, "superseded");
  try {
    const row = await store().create({
      data: withOrgFromCtx({
        id: randomUUID(),
        conversationId: args.conversationId,
        contactId: args.contactId,
        agentId: args.agentId,
        agentUserId: args.agentUserId,
        kind: "scheduled",
        dealId: args.dealId,
        dealStageIdAtCreate,
        dueAt: args.dueAt,
        requestedAt: args.requestedAt,
        reason: args.reason || null,
        resumeContext: args.resumeContext || null,
        status: "PENDING",
        idempotencyKey: scheduledKey(args.conversationId, args.turnKey),
      }),
    });
    return { ok: true, id: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "schedule_busy" };
    throw err;
  }
}
