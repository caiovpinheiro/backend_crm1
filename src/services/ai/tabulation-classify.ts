/**
 * Aplica uma folha da árvore de tabulações na conversa (e, se pedido,
 * encerra). Usado pela tabulação do agente e pelas automações.
 */

import { shouldFireConversationTabulatedTrigger } from "@/lib/ai-agents/tabulation-classify-policy";
import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { updateConversationStatusInDb } from "@/services/conversations";
import {
  resolveTabulationForStep,
  tabulationLogMeta,
} from "@/services/tabulations";

export type ApplyTabulationResult =
  | {
      ok: true;
      alreadyApplied: boolean;
      closed: boolean;
      tabulation: {
        tabulationId: string;
        ancestorIds: string[];
        departmentId: string;
        name: string;
        number: number;
      };
    }
  | { ok: false; error: string };

export async function applyConversationTabulation(args: {
  conversationId: string;
  organizationId: string;
  tabulationId: string;
  contactId?: string | null;
  source?: string;
  closeIfOpen?: boolean;
}): Promise<ApplyTabulationResult> {
  const chosen = await resolveTabulationForStep({
    organizationId: args.organizationId,
    tabulationId: args.tabulationId,
  });
  if (!chosen) {
    return { ok: false, error: "Tabulação inválida, inativa ou não é folha." };
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: args.conversationId, organizationId: args.organizationId },
    select: {
      id: true,
      status: true,
      tabulationId: true,
      contactId: true,
      externalId: true,
      organizationId: true,
    },
  });
  if (!conv) return { ok: false, error: "Conversa não encontrada." };

  const contactId = args.contactId ?? conv.contactId;
  const closeIfOpen = args.closeIfOpen === true;
  if (
    conv.status === "RESOLVED" &&
    !closeIfOpen &&
    (args.source ?? "AI_AGENT") === "AI_AGENT"
  ) {
    return { ok: false, error: "Conversa já encerrada." };
  }
  if (
    conv.tabulationId &&
    conv.tabulationId !== chosen.tabulationId &&
    (args.source ?? "AI_AGENT") === "AI_AGENT"
  ) {
    return { ok: false, error: "Conversa já tabulada. Não sobrescreva a folha." };
  }
  const alreadySame = conv.tabulationId === chosen.tabulationId;
  const shouldClose = closeIfOpen && conv.status !== "RESOLVED";

  if (alreadySame && !shouldClose) {
    return {
      ok: true,
      alreadyApplied: true,
      closed: false,
      tabulation: chosen,
    };
  }

  if (shouldClose) {
    const [keepAgent, keepDepartment] = await Promise.all([
      getOrgSettingBool("conversation.keepAgentOnEnd", false),
      getOrgSettingBool("conversation.keepDepartmentOnEnd", false),
    ]);
    await updateConversationStatusInDb(conv.id, "RESOLVED", {
      tabulationId: chosen.tabulationId,
      clearAssignedTo: !keepAgent,
      clearDepartment: !keepDepartment,
    });
    await logEvent({
      type: "CONVERSATION_CLOSED",
      entityType: "CONVERSATION",
      entityId: conv.id,
      entityLabel: conv.externalId ?? null,
      conversationId: conv.id,
      contactId,
      field: "status",
      oldValue: conv.status,
      newValue: "RESOLVED",
      meta: {
        action: "ai_tabulate_close",
        source: args.source ?? "AI_AGENT",
      },
    }).catch(() => null);
  } else if (!alreadySame) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { tabulationId: chosen.tabulationId },
    });
  }

  if (!alreadySame) {
    await logEvent({
      type: "CONVERSATION_TABULATED",
      entityType: "CONVERSATION",
      entityId: conv.id,
      entityLabel: conv.externalId ?? null,
      conversationId: conv.id,
      contactId,
      meta: tabulationLogMeta(chosen, {
        source: args.source ?? "AI_AGENT",
      }),
    }).catch(() => null);
  }

  try {
    sseBus.publish("conversation_timeline_updated", {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      type: alreadySame ? "CONVERSATION_CLOSED" : "CONVERSATION_TABULATED",
    });
  } catch {
    /* best-effort */
  }

  if (shouldFireConversationTabulatedTrigger(shouldClose)) {
    let dealId: string | undefined;
    if (contactId) {
      const deal = await prisma.deal.findFirst({
        where: { contactId, status: "OPEN" },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      dealId = deal?.id;
    }

    await fireTrigger("conversation_tabulated", {
      contactId: contactId ?? undefined,
      dealId,
      data: {
        tabulationId: chosen.tabulationId,
        ancestorIds: chosen.ancestorIds,
        departmentId: chosen.departmentId,
        conversationId: conv.id,
        source: args.source ?? "AI_AGENT",
      },
    }).catch(() => null);
  }

  return {
    ok: true,
    alreadyApplied: alreadySame,
    closed: shouldClose,
    tabulation: chosen,
  };
}
