/**
 * Tabulação de conversa: aplica uma folha da árvore de tabulações a um
 * atendimento (e, quando é o caso, encerra), com o gatilho
 * `conversation_tabulated` e o registro no histórico. Usado pelo motor v2
 * e pelos fluxos de automação.
 */

import {
  conversationHasRealAttendance,
  shouldFireConversationTabulatedTrigger,
  type AttendanceMessage,
} from "@/lib/ai-agents/tabulation-classify-policy";
import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { publishConversationTimelineUpdated } from "@/lib/realtime-events";
import { tabulationHistoryWindowStart } from "@/lib/zoned-date";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { updateConversationStatusInDb } from "@/services/conversations";
import {
  formatTabulationCatalogBlock,
  listActiveTabulationLeaves,
  resolveTabulationForStep,
  tabulationLogMeta,
} from "@/services/tabulations";

const CLASSIFY_USER_MESSAGE =
  "Leia só o histórico deste atendimento recente (hoje; se for fim de semana, desde sexta). Só tabule se houve troca real: o contato mandou dúvida, reclamação ou pedido E um humano ou IA de atendimento respondeu. Cumprimento (oi, bom dia, tudo bem), ok, obrigado, silêncio, campanha ou só mensagem da empresa NÃO são atendimento — NÃO chame tabulate_conversation. Classifique pelas mensagens, não por dados de cadastro. Se a conversa já tem folha, não chame a tool. Prefira folhas do departamento da conversa. Se nenhuma folha casar, não chame a tool. Não encerre. Não escreva ao cliente.";

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
    publishConversationTimelineUpdated({
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

export async function loadTabulationCatalogForConversation(args: {
  organizationId: string;
  conversationId?: string | null;
}): Promise<string> {
  let preferredDepartmentId: string | null = null;
  if (args.conversationId) {
    const conv = await prisma.conversation.findFirst({
      where: { id: args.conversationId, organizationId: args.organizationId },
      select: { departmentId: true },
    });
    preferredDepartmentId = conv?.departmentId ?? null;
  }
  const leaves = await listActiveTabulationLeaves({
    organizationId: args.organizationId,
  });
  return formatTabulationCatalogBlock(leaves, preferredDepartmentId);
}
