/**
 * Encerramento de conversa feito pelo agente IA (somente atendimento IA).
 * Dispara o mesmo gatilho da ação manual (`conversation_tabulated`) para
 * a automação "Encerramento" devolver o card ao funil acadêmico.
 */

import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { updateConversationStatusInDb } from "@/services/conversations";
import { resolveAutoCloseTabulation, tabulationLogMeta } from "@/services/tabulations";

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/** Pedido explícito do aluno para encerrar o atendimento com a IA. */
export function userWantsAiConversationClose(
  userMessage?: string | null,
): boolean {
  const msg = normalize(userMessage ?? "");
  if (!msg) return false;
  if (msg.length > 160) return false;
  if (
    /^(pode |quero |podeis |poderia )?(encerrar|finalizar|concluir)( (a |o )?(conversa|atendimento|chat))?[\s.!?]*$/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /(pode|quero|podeis|poderia).{0,20}(encerrar|finalizar|concluir).{0,30}(conversa|atendimento|chat)?/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /^(era so isso|so isso|e so isso|nao preciso mais|nao preciso de mais nada|pode fechar|pode finalizar)[\s.!?]*$/.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/** Aluno adia o restante ("deixa à noite", "depois eu mando as dúvidas"). */
export function userDefersUntilLater(userMessage?: string | null): boolean {
  const msg = normalize(userMessage ?? "");
  if (!msg || msg.length > 240) return false;
  if (
    /(deixa|deixo|ficar|fico).{0,24}(pra|para|a)?\s*(noite|tarde|depois|mais tarde)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (/quando (eu )?estiver estudando/.test(msg)) return true;
  if (
    /(envio|mando|te (chamo|falo)|volto).{0,28}(a noite|depois|mais tarde|quando)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /(a noite|depois|mais tarde).{0,28}(envio|mando|te (chamo|falo)|minhas duvidas)/.test(
      msg,
    )
  ) {
    return true;
  }
  return /depois (eu )?(te )?(chamo|falo|volto)/.test(msg);
}

/** Agradecimento que fecha o turno ("muito grata por toda ajuda"). */
export function userThanksAndWrapsUp(userMessage?: string | null): boolean {
  const raw = userMessage ?? "";
  const msg = normalize(raw);
  if (!msg || msg.length > 160) return false;
  if (/\?/.test(raw) && !/pode ser/.test(msg)) return false;
  if (/muito grat[ao]|gratidao/.test(msg)) return true;
  if (/obrigad[oa]s?.{0,24}(por )?(toda|tudo|a ajuda)/.test(msg)) return true;
  if (/valeu.{0,16}(tudo|ajuda|carinho)/.test(msg)) return true;
  return false;
}

export function userThanksOnly(userMessage?: string | null): boolean {
  const msg = normalize(userMessage ?? "")
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!msg || msg.length > 80) return false;
  return /^(muito )?(obrigad[oa]s?|valeu|grat[ao])( (vi|ta|tá|mesmo))?$/.test(
    msg,
  );
}

export function shouldCloseAiAfterStudentMessage(args: {
  userMessage: string;
  recentInbound?: string[];
}): { close: boolean; reason: string } {
  if (userWantsAiConversationClose(args.userMessage)) {
    return { close: true, reason: "explicit" };
  }
  if (userThanksAndWrapsUp(args.userMessage)) {
    return { close: true, reason: "thanks_wrapup" };
  }
  const recent = (args.recentInbound ?? []).join("\n");
  const deferred =
    userDefersUntilLater(args.userMessage) || userDefersUntilLater(recent);
  if (userThanksOnly(args.userMessage) && deferred) {
    return { close: true, reason: "thanks_after_defer" };
  }
  return { close: false, reason: "" };
}

export async function closeAiOnlyConversation(args: {
  conversationId: string;
  contactId?: string | null;
  reason?: string;
  /** Agradecimento conclusivo com a IA ainda responsável — fecha mesmo se um humano falou antes. */
  allowAfterHumanReply?: boolean;
}): Promise<{ closed: boolean; reason: string }> {
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
