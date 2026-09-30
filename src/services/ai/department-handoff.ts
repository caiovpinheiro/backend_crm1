/**
 * Transferência para departamento — capacidade GENÉRICA do CRM.
 *
 * Departamento, distribuição e fila existem para qualquer organização:
 * a conversa sai da IA, mantém o departamento já fixado nela e entra na
 * Distribuição Inteligente.
 */

import { prisma } from "@/lib/prisma";
import { createConversationEvent } from "@/services/conversation-events";
import { executeDistribution } from "@/services/distribution/engine";

export type ResolvedDepartment = { id: string; name: string };

export type DepartmentHandoffResult = {
  departmentId: string | null;
  departmentName: string | null;
  distribution: Awaited<ReturnType<typeof executeDistribution>> | null;
};

export type DepartmentHandoffArgs = {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  reason?: string;
};

/**
 * Define o departamento, solta a conversa da IA e aciona a Distribuição
 * Inteligente. Sem departamento, o motor ainda enfileira em
 * `DistributionPending` (fila de espera).
 */
export async function executeDepartmentHandoff(
  args: DepartmentHandoffArgs,
): Promise<DepartmentHandoffResult> {
  let dept: ResolvedDepartment | null = null;

  // Respeita o departamento já fixado na conversa.
  const current = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { departmentId: true, contactId: true },
  });
  if (current?.departmentId) {
    dept = await prisma.department.findUnique({
      where: { id: current.departmentId },
      select: { id: true, name: true },
    });
  }

  const contactId = args.contactId ?? current?.contactId ?? null;

  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      ...(dept ? { departmentId: dept.id } : {}),
      // Solta a IA. `aiGreetedAt` fica: zerar reenvia a saudação se o
      // agente reassumir a conversa depois.
      assignedToId: null,
      updatedAt: new Date(),
    },
    select: { id: true },
  });

  const distribution = await executeDistribution({
    dealId: args.dealId ?? null,
    contactId,
    conversationId: args.conversationId,
    triggerSource: "AI_AGENT",
    departmentId: dept?.id ?? null,
    reassign: true,
  });

  const selectedUserId =
    distribution?.success && distribution.selectedUserId
      ? distribution.selectedUserId
      : null;
  const selectedUser = selectedUserId
    ? await prisma.user.findUnique({
        where: { id: selectedUserId },
        select: { type: true, name: true },
      })
    : null;
  const selectedIsHuman = selectedUser?.type === "HUMAN";

  // Evento de timeline só na atribuição. Fila sem elegível não gera
  // evento — o sweeper reprocessa e spamava o chat.
  if (selectedIsHuman) {
    await createConversationEvent({
      conversationId: args.conversationId,
      action: "distribuicao",
      text:
        `Conversa distribuída para ${dept?.name ?? "atendimento"}` +
        (selectedUser?.name ? ` → ${selectedUser.name}` : ""),
      actor: "Agente IA",
      authorType: "bot",
      dedupeStartsWith: ["Conversa distribuída para"],
      dedupeWindowMs: 2 * 60 * 1000,
    }).catch(() => null);
  }

  // Alinha `Deal.owner` com o assignee da conversa: header do negócio e
  // automação de saudação (`lead_distributed`) na mesma pessoa.
  if (selectedIsHuman && selectedUserId && contactId) {
    try {
      const { assignDealOwner } = await import("@/services/deals");
      let dealId = args.dealId ?? null;
      if (!dealId) {
        const latest = await prisma.deal.findFirst({
          where: { contactId },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        });
        dealId = latest?.id ?? null;
      }
      if (dealId) await assignDealOwner(dealId, selectedUserId);
    } catch (e) {
      console.warn("[department-handoff] align deal owner failed", e);
    }
  }

  return {
    departmentId: dept?.id ?? null,
    departmentName: dept?.name ?? null,
    distribution,
  };
}
