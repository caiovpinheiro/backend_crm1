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
import {
  insertActivityOutbox,
  type ActivityOutboxInput,
} from "@/services/activity-outbox";
import { fireTrigger } from "@/services/automation-triggers";
import {
  updateConversationStatusInDb,
  updateConversationStatusInTx,
} from "@/services/conversations";
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

  const { row: updated } = await prisma.$transaction(async (tx) => {
    const result = await updateConversationStatusInTx(tx, conv.id, "RESOLVED", {
      ...(autoTab ? { tabulationId: autoTab.tabulationId } : {}),
      clearAssignedTo: !keepAgent,
      clearDepartment: !keepDepartment,
    });

    const closedAtIso = result.row.closedAt?.toISOString() ?? new Date().toISOString();

    await insertActivityOutbox(tx, {
      type: "CONVERSATION_CLOSED",
      actorType: "AI",
      actorLabel: "Agente IA",
      entityType: "CONVERSATION",
      entityId: conv.id,
      entityLabel: result.row.externalId ?? null,
      conversationId: conv.id,
      contactId,
      field: "status",
      oldValue: conv.status,
      newValue: "RESOLVED",
      organizationId: result.row.organizationId,
      meta: {
        action: "ai_close",
        source: "AI_AGENT",
        reason: args.reason ?? null,
      },
      idempotencyKey: `conversation:${conv.id}:closed:${closedAtIso}`,
    });

    if (autoTab) {
      await insertActivityOutbox(tx, {
        type: "CONVERSATION_TABULATED",
        actorType: "AI",
        actorLabel: "Agente IA",
        entityType: "CONVERSATION",
        entityId: conv.id,
        entityLabel: result.row.externalId ?? null,
        conversationId: conv.id,
        contactId,
        departmentId: conv.departmentId,
        organizationId: result.row.organizationId,
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
        idempotencyKey: `conversation:${conv.id}:tabulated:${autoTab.tabulationId}:${closedAtIso}`,
      });
    }

    return result;
  });

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

  const closer = await prisma.user.findFirst({
    where: { id: conv.assignedToId ?? "", type: "AI" },
    select: { aiAgentConfig: { select: { inboxPolicy: true, verticalPack: true } } },
  });
  if (closer?.aiAgentConfig) {
    const { normalizeInboxPolicy } = await import("@/lib/ai-agents/steering");
    const { maybeTabulateOnExit } = await import(
      "@/services/ai/tabulation-classify"
    );
    await maybeTabulateOnExit({
      organizationId: conv.organizationId,
      contactId,
      policy: normalizeInboxPolicy(
        closer.aiAgentConfig.inboxPolicy,
        closer.aiAgentConfig.verticalPack,
      ),
      trigger: "close",
    }).catch(() => null);
  }

  return { closed: true, reason: "CLOSED" };
}
