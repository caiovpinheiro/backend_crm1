/**
 * "Manter dono do negócio" — atender só a conversa.
 *
 * Regra padrão do CRM (responsável único): quem recebe a conversa vira dono
 * do negócio, do contato e de todas as conversas do contato
 * (`assignDealOwner` / `propagateOwnerToContactAndChat`).
 *
 * Com `Department.keepDealOwner = true`, a distribuição e a transferência
 * que caem neste departamento trocam SÓ o responsável da conversa. O dono
 * do negócio e o do contato ficam como estão. Ex.: o vendedor continua dono
 * do negócio enquanto o Financeiro ou o Suporte atende a conversa.
 *
 * Só preserva dono HUMANO: negócio sem dono, ou com um agente de IA como
 * dono, segue a regra padrão — senão o negócio ficaria órfão ou preso na IA.
 *
 * `override` (checkbox "Manter dono do negócio" do modal do inbox) troca a
 * decisão do departamento naquela ação.
 */

import { prisma } from "@/lib/prisma";
import {
  logConversationAssigneeChanges,
  type ConversationAssigneeChange,
} from "@/services/deals";

/** O departamento pede para manter o dono do negócio? Sem depto = não. */
export async function departmentKeepsDealOwner(
  departmentId: string | null | undefined,
): Promise<boolean> {
  if (!departmentId) return false;
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { keepDealOwner: true },
  });
  return dept?.keepDealOwner === true;
}

/** Algum negócio ABERTO do contato tem dono humano? */
export async function contactHasHumanDealOwner(
  contactId: string | null | undefined,
): Promise<boolean> {
  if (!contactId) return false;
  const deal = await prisma.deal.findFirst({
    where: {
      contactId,
      status: "OPEN",
      ownerId: { not: null },
      owner: { type: "HUMAN" },
    },
    select: { id: true },
  });
  return deal !== null;
}

/**
 * Decide se esta atribuição troca só a conversa.
 * `override` (true/false) vence o departamento; sem override vale o
 * `departmentId` informado — `undefined` = o departamento da conversa.
 * Precisa de conversa e de um dono humano a preservar.
 */
export async function resolveKeepDealOwner(args: {
  conversationId: string | null | undefined;
  contactId?: string | null;
  departmentId?: string | null;
  override?: boolean | null;
}): Promise<boolean> {
  if (!args.conversationId) return false;
  let contactId = args.contactId ?? null;
  let departmentId = args.departmentId;
  const needsOverride = typeof args.override === "boolean";
  if (!contactId || (!needsOverride && departmentId === undefined)) {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { contactId: true, departmentId: true },
    });
    contactId = contactId ?? conv?.contactId ?? null;
    if (departmentId === undefined) departmentId = conv?.departmentId ?? null;
  }
  const wants = needsOverride
    ? args.override === true
    : await departmentKeepsDealOwner(departmentId);
  if (!wants) return false;
  return contactHasHumanDealOwner(contactId);
}

/**
 * Atribui (ou remove) SÓ o responsável da conversa. Não toca contato nem
 * negócio. Registra ASSIGNEE_CHANGED — sem ele o próximo inbound trata o
 * consultor como herança (ver `assignDealOwner`).
 */
export async function assignConversationOnly(args: {
  conversationId: string;
  userId: string | null;
  via?: string | null;
}): Promise<ConversationAssigneeChange | null> {
  const change = await prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: {
        id: true,
        contactId: true,
        externalId: true,
        assignedToId: true,
        assignedTo: { select: { name: true } },
      },
    });
    if (!current) return null;
    let toName: string | null = null;
    let newIsAi = false;
    if (args.userId) {
      const user = await tx.user.findUnique({
        where: { id: args.userId },
        select: { name: true, type: true },
      });
      toName = user?.name ?? null;
      newIsAi = user?.type === "AI";
    }
    const changed = (current.assignedToId ?? null) !== (args.userId ?? null);
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: {
        assignedToId: args.userId,
        assignedVia: args.via ?? null,
        // Atribuição concreta consome a rota pendente; remoção a preserva.
        ...(args.userId !== null ? { routeMode: null } : {}),
        ...(changed && newIsAi ? { aiGreetedAt: null } : {}),
      },
      select: { id: true },
    });
    if (!changed) return null;
    return {
      conversationId: current.id,
      contactId: current.contactId,
      entityLabel: current.externalId ?? null,
      fromUserId: current.assignedToId,
      fromName: current.assignedTo?.name ?? null,
      toUserId: args.userId,
      toName,
    } satisfies ConversationAssigneeChange;
  });
  if (change) await logConversationAssigneeChanges([change]);
  return change;
}
