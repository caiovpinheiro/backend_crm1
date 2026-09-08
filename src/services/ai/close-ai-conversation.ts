/**
 * Encerramento de conversa feito pelo agente IA — capacidade GENÉRICA.
 *
 * O corpo vivia em `src/verticals/academic/closure.ts`, então agente sem
 * vertical nunca encerrava ticket: o worker de inatividade chamava
 * `getVerticalPack("academic")?.ops.closeAiOnlyConversation?.()` e o
 * `?.` engolia o encerramento em silêncio. Nada aqui é acadêmico — o
 * único trecho que era (devolver o card ao funil de origem) entra pelo
 * hook `onClosed`, que o pack preenche.
 */

import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { updateConversationStatusInDb } from "@/services/conversations";
import {
  resolveAutoCloseTabulation,
  tabulationLogMeta,
} from "@/services/tabulations";

export type CloseAiConversationArgs = {
  conversationId: string;
  contactId?: string | null;
  reason?: string;
  /** Agradecimento conclusivo com a IA ainda responsável — fecha mesmo se um humano falou antes. */
  allowAfterHumanReply?: boolean;
  /**
   * Refino de vertical, chamado DEPOIS do RESOLVED e ANTES do gatilho de
   * automação (a automação de encerramento precisa ver a etapa final).
   */
  onClosed?: (ctx: {
    dealId: string | null;
    contactId: string | null;
  }) => Promise<void>;
};

export async function closeAiOnlyConversation(
  args: CloseAiConversationArgs,
): Promise<{ closed: boolean; reason: string }> {
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      id: true,
      status: true,
      contactId: true,
      departmentId: true,
      hasHumanReply: true,
      assignedToId: true,
      organizationId: true,
      externalId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conv) return { closed: false, reason: "NOT_FOUND" };
  if (conv.status === "RESOLVED") {
    return { closed: false, reason: "ALREADY_CLOSED" };
  }
  // Somente atendimento da IA — se humano já respondeu, não encerra
  // (salvo wrap-up natural: aluno agradeceu e a IA ainda é a responsável).
  if (conv.hasHumanReply && !args.allowAfterHumanReply) {
    return { closed: false, reason: "HAS_HUMAN_REPLY" };
  }
  if (conv.assignedTo?.type !== "AI") {
    return { closed: false, reason: "NOT_AI_ASSIGNEE" };
  }

  const contactId = args.contactId ?? conv.contactId;

  await prisma.distributionPending
    .updateMany({
      where: {
        status: "PENDING",
        OR: [
          { conversationId: conv.id },
          ...(contactId ? [{ contactId }] : []),
        ],
      },
      data: { status: "CANCELLED" },
    })
    .catch(() => 0);

  const [keepAgent, keepDepartment] = await Promise.all([
    getOrgSettingBool("conversation.keepAgentOnEnd", false),
    getOrgSettingBool("conversation.keepDepartmentOnEnd", false),
  ]);

  // Tabulação padrão do departamento para encerramento automático. Sem ela
  // a IA fecha sem tabular (comportamento anterior) — nunca bloqueia.
  const autoTab = await resolveAutoCloseTabulation({
    organizationId: conv.organizationId,
    departmentId: conv.departmentId,
  }).catch(() => null);

  const updated = await updateConversationStatusInDb(conv.id, "RESOLVED", {
    ...(autoTab ? { tabulationId: autoTab.tabulationId } : {}),
    clearAssignedTo: !keepAgent,
    clearDepartment: !keepDepartment,
  });

  await logEvent({
    type: "CONVERSATION_CLOSED",
    entityType: "CONVERSATION",
    entityId: conv.id,
    entityLabel: updated.externalId ?? null,
    conversationId: conv.id,
    contactId,
    field: "status",
    oldValue: conv.status,
    newValue: "RESOLVED",
    meta: {
      action: "ai_close",
      source: "AI_AGENT",
      reason: args.reason ?? null,
    },
  }).catch(() => null);

  if (autoTab) {
    await logEvent({
      type: "CONVERSATION_TABULATED",
      entityType: "CONVERSATION",
      entityId: conv.id,
      entityLabel: updated.externalId ?? null,
      conversationId: conv.id,
      contactId,
      meta: tabulationLogMeta(
        {
          tabulationId: autoTab.tabulationId,
          ancestorIds: autoTab.ancestorIds,
          departmentId: conv.departmentId,
          name: autoTab.name,
          number: autoTab.number,
        },
        { source: "AI_AGENT", auto: true },
      ),
    }).catch(() => null);
  }

  try {
    sseBus.publish("conversation_timeline_updated", {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      type: "CONVERSATION_CLOSED",
    });
  } catch {
    /* best-effort */
  }

  let dealId: string | undefined;
  if (contactId) {
    const deal = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    dealId = deal?.id;
  }

  if (args.onClosed && (dealId || contactId)) {
    try {
      await args.onClosed({
        dealId: dealId ?? null,
        contactId: contactId ?? null,
      });
    } catch (e) {
      console.warn("[ai-close] refino de vertical falhou", e);
    }
  }

  await fireTrigger("conversation_tabulated", {
    contactId: contactId ?? undefined,
    dealId,
    data: {
      tabulationId: autoTab?.tabulationId ?? null,
      ancestorIds: autoTab?.ancestorIds ?? [],
      departmentId: conv.departmentId,
      conversationId: conv.id,
      source: "AI_AGENT",
      reason: args.reason ?? null,
    },
  }).catch(() => null);

  return { closed: true, reason: "CLOSED" };
}
