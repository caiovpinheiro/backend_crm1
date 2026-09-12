/**
 * Verifica se um userId humano ainda está elegível na Distribuição
 * (ONLINE, horário, fila, participa). Agentes IA retornam
 * `eligible: false` + `isAi: true` — nunca fecham fila humana.
 */

import { prisma } from "@/lib/prisma";
import type { DistributionBlockReason } from "@/services/distribution/eligibility";
import { getDistributionResponsibles } from "@/services/distribution/responsibles";

/**
 * Fila cheia ≠ offline: o dono humano continua responsável. Limpar ownership
 * só por QUEUE_LIMIT devolve o lead à fila de espera sem ninguém elegível
 * (loop de attempts). Offline / fora do expediente / etc. seguem limpando.
 *
 * Se houver vários motivos, limpa se QUALQUER um não for fila cheia
 * (ex.: OFFLINE + QUEUE_LIMIT → limpa).
 */
export function shouldClearOwnershipOnIneligible(
  reason: string | undefined,
  blockedReasons?: readonly string[],
): boolean {
  const reasons =
    blockedReasons && blockedReasons.length > 0
      ? blockedReasons
      : reason
        ? [reason]
        : [];
  if (reasons.length === 0) return true;
  return reasons.some((r) => r !== "QUEUE_LIMIT_REACHED");
}

/**
 * Conversa já respondida por humano não troca de dono no inbound / motor
 * sem `reassign`. Almoço (`PRE_LUNCH`), offline, pausa ou outro departamento
 * param lead NOVO — não arrancam o aluno no meio do "ótimo" (09/set/26
 * #359447 e 08/set/26). Sem resposta humana, divergência de departamento
 * ainda redistribui; offline / fora do expediente também.
 */
export function shouldKeepAssigneeInAttendance(args: {
  /** O passo pediu um pool de departamentos. */
  departmentScoped: boolean;
  /** Dono é elegível DENTRO do pool pedido. */
  eligibleInDepartment: boolean;
  /** Dono é elegível ignorando o departamento — só o depto o barra. */
  eligibleOutsideDepartment: boolean;
  /** Humano já respondeu NESTA conversa. */
  hasHumanReply: boolean;
  isAi: boolean;
}): boolean {
  if (args.isAi) return false;
  // Atendimento em curso: inelegibilidade transitória não solta o dono.
  if (args.hasHumanReply) return true;
  if (!args.departmentScoped) return false;
  if (args.eligibleInDepartment) return false;
  // Barrado por algo além do departamento (offline etc.) → redistribui.
  if (!args.eligibleOutsideDepartment) return false;
  return false;
}

/**
 * @param departmentIds Pool de departamentos pedido por quem chamou (passo
 * `execute_distribution`, handoff). Quando preenchido, o dono atual só é
 * considerado elegível se for membro de um deles — senão volta
 * `DEPARTMENT_MISMATCH` e o lead é redistribuído dentro do departamento
 * pedido. Vazio/omitido = sem restrição de departamento (comportamento
 * anterior).
 */
export async function isAssigneeCurrentlyEligible(
  userId: string,
  departmentIds?: readonly string[] | null,
): Promise<{
  eligible: boolean;
  isAi: boolean;
  reason?: string;
  blockedReasons?: DistributionBlockReason[];
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, type: true },
  });
  if (!user) return { eligible: false, isAi: false, reason: "USER_NOT_FOUND" };
  if (user.type === "AI") return { eligible: false, isAi: true, reason: "AI_NOT_HUMAN_DISTRIBUTION" };

  try {
    const views = await getDistributionResponsibles(
      departmentIds && departmentIds.length > 0
        ? { departmentIds: [...departmentIds] }
        : {},
    );
    const view = views.find((r) => r.userId === userId);
    if (!view) {
      // Humano fora do módulo de distribuição: não herdar automaticamente.
      return { eligible: false, isAi: false, reason: "NOT_IN_DISTRIBUTION" };
    }
    if (!view.eligible) {
      return {
        eligible: false,
        isAi: false,
        reason: view.blockedReasons[0] ?? "INELIGIBLE",
        blockedReasons: view.blockedReasons,
      };
    }
    return { eligible: true, isAi: false };
  } catch {
    // Sem widget / erro: conservador — não herda offline.
    return { eligible: false, isAi: false, reason: "ELIGIBILITY_CHECK_FAILED" };
  }
}

/** Limpa dono em conversa + contato + deals OPEN (para redistribuir). */
export async function clearOwnershipForRedistribution(args: {
  conversationId: string;
  contactId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { assignedToId: null },
      select: { id: true },
    });
    await tx.contact.update({
      where: { id: args.contactId },
      data: { assignedToId: null },
    });
    await tx.deal.updateMany({
      where: { contactId: args.contactId, status: "OPEN" },
      data: { ownerId: null },
    });
  });
}
