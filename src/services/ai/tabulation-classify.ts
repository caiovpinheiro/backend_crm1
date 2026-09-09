/**
 * Classificação silenciosa: o agente lê o histórico e aplica uma folha
 * da árvore de tabulações. Não envia WhatsApp.
 *
 * Disparado pelo passo `transfer_to_ai_agent` quando o alvo é um
 * classificador (`TABULACAO` ou tool `tabulate_conversation`).
 */

import { prisma } from "@/lib/prisma";
import { getOrgSettingBool } from "@/lib/org-settings";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { updateConversationStatusInDb } from "@/services/conversations";
import { tabulationHistoryWindowStart } from "@/lib/zoned-date";
import {
  formatTabulationCatalogBlock,
  listActiveTabulationLeaves,
  resolveClassifierFallbackTabulation,
  resolveTabulationForStep,
  tabulationLogMeta,
} from "@/services/tabulations";
import {
  isTabulationClassifier,
  TABULATION_CLASSIFIER_TOOLS,
} from "@/lib/ai-agents/tabulation-classifier";

const CLASSIFY_USER_MESSAGE =
  "Leia só o histórico deste atendimento recente (hoje; se for fim de semana, desde sexta). Identifique a dúvida ou o problema desta troca — ignore assuntos antigos que não estejam nesse recorte. No catálogo de TODA a organização, escolha a folha cujo caminho mais se aproxima desse assunto — não se limite ao departamento da conversa. Prefira a folha mais específica. Chame `tabulate_conversation` com esse id. Fallback só se nenhuma folha tiver relação. Não escreva mensagem para o cliente.";

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
  const leaves = await listActiveTabulationLeaves({
    organizationId: args.organizationId,
  });
  const fallback = await resolveClassifierFallbackTabulation({
    organizationId: args.organizationId,
  }).catch(() => null);
  const fallbackOpt = fallback
    ? {
        id: fallback.tabulationId,
        path:
          leaves.find((l) => l.id === fallback.tabulationId)?.path ??
          fallback.name,
      }
    : null;
  return formatTabulationCatalogBlock(leaves, fallbackOpt);
}

export type ClassifyTriggerResult =
  | { status: "classified"; tabulationId: string; tabulationName?: string }
  | { status: "fallback"; tabulationId: string; tabulationName?: string }
  | {
      status: "skipped";
      reason:
        | "no_conversation"
        | "not_classifier"
        | "agent_inactive"
        | "not_ai_agent";
    }
  | { status: "failed"; reason: string };

export async function triggerTabulationClassifyForContact(args: {
  contactId: string;
  agentUserId: string;
}): Promise<ClassifyTriggerResult> {
  const assignee = await prisma.user.findUnique({
    where: { id: args.agentUserId },
    select: {
      id: true,
      type: true,
      name: true,
      aiAgentConfig: {
        select: {
          id: true,
          active: true,
          archetype: true,
          enabledTools: true,
        },
      },
    },
  });
  if (!assignee || assignee.type !== "AI" || !assignee.aiAgentConfig) {
    return { status: "skipped", reason: "not_ai_agent" };
  }
  const cfg = assignee.aiAgentConfig;
  if (!cfg.active) return { status: "skipped", reason: "agent_inactive" };
  if (!isTabulationClassifier({ ...cfg, name: assignee.name })) {
    return { status: "skipped", reason: "not_classifier" };
  }

  const conversation = await prisma.conversation.findFirst({
    where: { contactId: args.contactId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      organizationId: true,
      departmentId: true,
      contactId: true,
    },
  });
  if (!conversation) return { status: "skipped", reason: "no_conversation" };

  const leaves = await listActiveTabulationLeaves({
    organizationId: conversation.organizationId,
  });
  if (leaves.length === 0) {
    return {
      status: "failed",
      reason:
        "Nenhuma folha de tabulação ativa. Cadastre a árvore em Settings → Tabulações.",
    };
  }

  const openDeal = await prisma.deal.findFirst({
    where: { contactId: args.contactId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  const { runAgent } = await import("@/services/ai/runner");
  const classifyTools = Array.from(
    new Set([...(cfg.enabledTools ?? []), ...TABULATION_CLASSIFIER_TOOLS]),
  );
  const result = await runAgent({
    agentId: cfg.id,
    source: "automation",
    userMessage: CLASSIFY_USER_MESSAGE,
    conversationId: conversation.id,
    contactId: args.contactId,
    dealId: openDeal?.id ?? null,
    enabledTools: classifyTools,
    forceTabulateTool: true,
    historySince: tabulationHistoryWindowStart(
      new Date(),
      "America/Sao_Paulo",
    ),
    historyLimit: 80,
  });

  const tabulated = result.toolCalls.find(
    (c) =>
      c.name === "tabulate_conversation" &&
      c.result &&
      typeof c.result === "object" &&
      (c.result as { ok?: unknown }).ok === true,
  );
  if (tabulated) {
    const tabulationId =
      typeof (tabulated.result as { tabulationId?: unknown }).tabulationId ===
      "string"
        ? (tabulated.result as { tabulationId: string }).tabulationId
        : "";
    return {
      status: "classified",
      tabulationId,
      tabulationName:
        typeof (tabulated.result as { tabulationName?: unknown }).tabulationName ===
        "string"
          ? (tabulated.result as { tabulationName: string }).tabulationName
          : undefined,
    };
  }

  const toolFail = result.toolCalls
    .filter((c) => c.name === "tabulate_conversation")
    .map((c) => {
      const r = c.result as { ok?: unknown; error?: unknown } | undefined;
      if (r && r.ok === false && typeof r.error === "string") return r.error;
      return null;
    })
    .find((e): e is string => Boolean(e));

  const fallback = await resolveClassifierFallbackTabulation({
    organizationId: conversation.organizationId,
    departmentId: conversation.departmentId,
  }).catch(() => null);
  const singleLeaf = !fallback && leaves.length === 1 ? leaves[0] : null;
  const chosenFallback = fallback
    ? {
        tabulationId: fallback.tabulationId,
        name: fallback.name,
      }
    : singleLeaf
      ? { tabulationId: singleLeaf.id, name: singleLeaf.path }
      : null;
  if (!chosenFallback) {
    return {
      status: "failed",
      reason:
        toolFail ??
        result.error ??
        "Agente não escolheu uma folha. Defina a tabulação padrão de encerramento no departamento (Settings → Departamentos).",
    };
  }

  const applied = await applyConversationTabulation({
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    tabulationId: chosenFallback.tabulationId,
    contactId: args.contactId,
    source: "AI_AGENT",
    closeIfOpen: false,
  });
  if (!applied.ok) {
    return { status: "failed", reason: applied.error };
  }
  return {
    status: "fallback",
    tabulationId: chosenFallback.tabulationId,
    tabulationName: chosenFallback.name,
  };
}
