/**
 * Linhas antigas de `distribution_leads_pending`.
 *
 * O modo por leads não enfileira mais: sem peso, o card fica sem
 * responsável. A drenagem só termina o que já estava PENDING — atribui se
 * houver peso > 0 e marca RESOLVED. Fila de espera nova é só da
 * distribuição inteligente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { eligibleUserIdsForScope, readLeadsScope } from "@/services/ai-v2/leads-handoff";

const DRAIN_BATCH = 100;

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
 * Atribui as linhas que já estavam PENDING, da mais antiga para a mais
 * nova. Quem já ganhou dono humano sai sem ser redistribuído. Sem peso, a
 * linha continua PENDING até alguém ter peso — o motor novo não cria outra.
 */
export async function drainLeadsPending(): Promise<number> {
  const orgId = getOrgIdOrThrow();
  const { executeLeadsDistribution } = await import("./engine");
  let assigned = 0;
  // Um recorte sem peso não trava o restante das linhas antigas.
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
      // Recorte sem peso agora: segue para a próxima linha antiga.
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
