/**
 * Fila da Distribuição por Leads.
 *
 * Sem consultor elegível (ACTIVE com peso > 0), o lead fica aqui — fora do
 * smart, porque a conversa está com routeMode="leads". A drenagem roda
 * quando um participante passa a poder receber (upsert com peso > 0, ou
 * o kill switch do modo é ligado).
 */

import { Prisma } from "@prisma/client";

import type { ScopedTx } from "@/lib/prisma";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { eligibleUserIdsForScope, readLeadsScope, type LeadsRoutingScope } from "@/services/ai-v2/leads-handoff";

const DRAIN_BATCH = 100;

export async function enqueueLeadsPending(
  tx: ScopedTx,
  args: {
    organizationId: string;
    targetKey: string;
    contactId: string | null;
    dealId: string | null;
    conversationId: string | null;
    triggerSource: string;
    scope?: LeadsRoutingScope | null;
  },
): Promise<"created" | "updated"> {
  const existing = await tx.distributionLeadsPending.findFirst({
    where: {
      organizationId: args.organizationId,
      targetKey: args.targetKey,
      status: "PENDING",
    },
    select: { id: true },
  });
  const scopeData = args.scope ? { scope: args.scope as Prisma.InputJsonValue } : {};
  if (existing) {
    await tx.distributionLeadsPending.update({
      where: { id: existing.id },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), ...scopeData },
    });
    return "updated";
  }
  await tx.distributionLeadsPending.create({
    data: {
      organizationId: args.organizationId,
      targetKey: args.targetKey,
      contactId: args.contactId,
      dealId: args.dealId,
      conversationId: args.conversationId,
      triggerSource: args.triggerSource,
      status: "PENDING",
      ...scopeData,
    },
  });
  return "created";
}

async function humanOwnerId(row: {
  conversationId: string | null;
  dealId: string | null;
  contactId: string | null;
}): Promise<string | null> {
  if (row.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: row.conversationId },
      select: { assignedToId: true, assignedTo: { select: { type: true } } },
    });
    if (conv?.assignedToId && conv.assignedTo?.type === "HUMAN") return conv.assignedToId;
  }
  if (row.dealId) {
    const deal = await prisma.deal.findUnique({
      where: { id: row.dealId },
      select: { ownerId: true, owner: { select: { type: true } } },
    });
    if (deal?.ownerId && deal.owner?.type === "HUMAN") return deal.ownerId;
  }
  if (row.contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: row.contactId },
      select: { assignedToId: true, assignedTo: { select: { type: true } } },
    });
    if (contact?.assignedToId && contact.assignedTo?.type === "HUMAN") {
      return contact.assignedToId;
    }
  }
  return null;
}

/**
 * Atribui os leads que estavam sem consultor, do mais antigo para o mais
 * novo. Para no primeiro que ainda não tem elegível (o rodízio continua
 * vazio). Quem já ganhou dono humano sai da fila sem ser redistribuído.
 */
export async function drainLeadsPending(): Promise<number> {
  const orgId = getOrgIdOrThrow();
  const { executeLeadsDistribution } = await import("./engine");
  let assigned = 0;
  // Card da IA esperando o expediente não pode travar o restante da fila.
  const waitingOnScope: string[] = [];

  for (let i = 0; i < DRAIN_BATCH; i++) {
    const next = await prisma.distributionLeadsPending.findFirst({
      where: {
        organizationId: orgId,
        status: "PENDING",
        ...(waitingOnScope.length > 0 ? { id: { notIn: waitingOnScope } } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        contactId: true,
        dealId: true,
        conversationId: true,
        scope: true,
      },
    });
    if (!next) break;

    const ownedBy = await humanOwnerId(next);
    if (ownedBy) {
      await prisma.distributionLeadsPending.update({
        where: { id: next.id },
        data: {
          status: "RESOLVED",
          resolvedUserId: ownedBy,
          resolvedAt: new Date(),
        },
      });
      continue;
    }

    const scope = readLeadsScope(next.scope);
    const onlyUserIds = scope ? await eligibleUserIdsForScope(scope) : undefined;
    const result = await executeLeadsDistribution({
      dealId: next.dealId,
      contactId: next.contactId,
      conversationId: next.conversationId,
      triggerSource: "SYSTEM",
      ...(scope ? { onlyUserIds, pendingScope: scope } : {}),
    });

    if (result.reason !== "ASSIGNED" && result.reason !== "DONO_PRESERVADO") {
      await prisma.distributionLeadsPending.update({
        where: { id: next.id },
        data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
      });
      // Recorte da IA sem ninguém online agora: segue para o próximo lead.
      // O rodízio da org pode ter gente; este card espera o expediente dele.
      if (scope) {
        waitingOnScope.push(next.id);
        continue;
      }
      break;
    }

    await prisma.distributionLeadsPending.updateMany({
      where: { id: next.id, status: "PENDING" },
      data: {
        status: "RESOLVED",
        resolvedUserId: result.selectedUserId,
        resolvedAt: new Date(),
      },
    });
    if (result.reason === "ASSIGNED") assigned += 1;
  }

  return assigned;
}
