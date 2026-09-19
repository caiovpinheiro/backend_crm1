/**
 * Notificação de stakeholders de produto/vaga.
 *
 * Dois momentos:
 *   - `notifyStakeholdersOnSend`: avisa stakeholders com `notifyOnSend` que o
 *     processo (ex.: candidato enviado ao cliente) avançou.
 *   - `requestStakeholderFeedback`: solicita feedback aos `notifyForFeedback`.
 *
 * LGPD (princípio 5 — minimização): a mensagem carrega o MÍNIMO necessário
 * (nome do sujeito + rótulo/id do processo). NUNCA currículo, documentos ou
 * dados sensíveis. O conteúdo estruturado do feedback é capturado na resposta
 * via WhatsApp Flow existente (`whatsapp-flow-response.ts`).
 *
 * Stakeholder é SEMPRE um `Contact` existente (nunca telefone/email solto):
 * resolvemos o canal pela conversa mais recente do contato.
 *
 * TODOs documentados:
 *   - Canal EMAIL: não há provider de e-mail transacional wired hoje → apenas
 *     registra ActivityEvent pendente. Plugar quando houver provider.
 *   - Envio PROATIVO de WhatsApp Flow (form): hoje enviamos um convite em texto;
 *     a resposta estruturada é processada pela infra de flows na entrada.
 *   - Guarda-chuva `settings:lgpd`: gate de consentimento ainda não existe como
 *     setting dedicada; a minimização acima é a salvaguarda atual.
 */
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { sendWhatsAppText } from "@/lib/send-whatsapp";
import { logEvent } from "@/services/activity-log";

const log = getLogger("stakeholder-notify");

type NotifyParams = {
  productId?: string | null;
  jobOpeningId?: string | null;
  /** Nome do sujeito do processo (ex.: nome do candidato). Dado mínimo. */
  subjectName: string;
  /** Rótulo curto do processo (ex.: "Vaga: Dev Backend"). Dado mínimo. */
  processLabel: string;
  /** Deal do processo (candidato) para audit trail. */
  dealId?: string | null;
};

type StakeholderRow = {
  id: string;
  contactId: string;
  role: string;
  channelPreference: "WHATSAPP" | "EMAIL";
  contact: { id: string; name: string };
};

async function loadStakeholders(
  params: NotifyParams,
  flag: "notifyOnSend" | "notifyForFeedback",
): Promise<StakeholderRow[]> {
  if (!params.productId && !params.jobOpeningId) return [];
  return prisma.productStakeholder.findMany({
    where: {
      [flag]: true,
      ...(params.jobOpeningId
        ? { jobOpeningId: params.jobOpeningId }
        : { productId: params.productId }),
    },
    select: {
      id: true,
      contactId: true,
      role: true,
      channelPreference: true,
      contact: { select: { id: true, name: true } },
    },
  });
}

/** Resolve a conversa mais recente do contato (canal + jid p/ envio). */
async function resolveContactChannel(contactId: string): Promise<{
  conversationId: string;
  channelRef: { id: string; provider: string } | null;
  waJid: string | null;
} | null> {
  const conv = await prisma.conversation.findFirst({
    where: { contactId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      waJid: true,
      channelRef: { select: { id: true, provider: true } },
    },
  });
  if (!conv) return null;
  return {
    conversationId: conv.id,
    channelRef: conv.channelRef
      ? { id: conv.channelRef.id, provider: conv.channelRef.provider }
      : null,
    waJid: conv.waJid,
  };
}

/** Entrega um texto mínimo a um stakeholder no canal preferido. */
async function deliver(
  st: StakeholderRow,
  text: string,
  dealId: string | null | undefined,
): Promise<void> {
  if (st.channelPreference === "EMAIL") {
    // TODO: sem provider de e-mail transacional. Registra pendência.
    void logEvent({
      type: "STAKEHOLDER_NOTIFY_PENDING",
      actorType: "AUTOMATION",
      entityType: "CONTACT",
      entityId: st.contactId,
      contactId: st.contactId,
      dealId: dealId ?? null,
      meta: { channel: "EMAIL", reason: "no_email_provider", role: st.role },
    });
    return;
  }

  const ch = await resolveContactChannel(st.contactId);
  if (!ch || !ch.channelRef) {
    void logEvent({
      type: "STAKEHOLDER_NOTIFY_PENDING",
      actorType: "AUTOMATION",
      entityType: "CONTACT",
      entityId: st.contactId,
      contactId: st.contactId,
      dealId: dealId ?? null,
      meta: { channel: "WHATSAPP", reason: "no_conversation", role: st.role },
    });
    return;
  }

  const msg = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: ch.conversationId,
      content: text,
      direction: "out",
      messageType: "text",
      senderName: "Notificação",
    }),
    select: { id: true },
  });

  const result = await sendWhatsAppText({
    conversationId: ch.conversationId,
    contactId: st.contactId,
    channelRef: ch.channelRef,
    content: text,
    messageId: msg.id,
    waJid: ch.waJid,
  });

  if (result.failed) {
    log.warn(`Notificação a stakeholder falhou (contato=${st.contactId}): ${result.error}`);
  }

  await prisma.conversation
    .update({
      where: { id: ch.conversationId },
      data: { lastMessageDirection: "out", updatedAt: new Date() },
    })
    .catch(() => {});
}

/** Notifica stakeholders `notifyOnSend` que o processo avançou. */
export async function notifyStakeholdersOnSend(
  params: NotifyParams,
): Promise<{ notified: number }> {
  const stakeholders = await loadStakeholders(params, "notifyOnSend");
  let notified = 0;
  for (const st of stakeholders) {
    const text =
      `Olá, ${st.contact.name}. Atualização do processo "${params.processLabel}": ` +
      `${params.subjectName} avançou de etapa.`;
    try {
      await deliver(st, text, params.dealId);
      notified++;
    } catch (err) {
      log.warn("notifyStakeholdersOnSend falhou:", err);
    }
  }
  if (params.dealId) {
    void logEvent({
      type: "STAKEHOLDERS_NOTIFIED",
      actorType: "AUTOMATION",
      entityType: "DEAL",
      entityId: params.dealId,
      dealId: params.dealId,
      meta: { notified, total: stakeholders.length },
    });
  }
  return { notified };
}

/**
 * Avalia as `StakeholderRule` de um produto para um evento de domínio
 * (STAGE_ENTERED, DEAL_WON, DEAL_LOST, ALLOCATION_CONSUMED) e notifica os
 * stakeholders cujo papel casa com a regra (PRD: capability `stakeholders`).
 *
 * Agnóstico: a regra (event × role × templateRef) vem de dados, não de código.
 * O `templateRef` é repassado no ActivityEvent; o envio proativo de template/
 * Flow estruturado fica como TODO (hoje entrega convite em texto mínimo, LGPD).
 */
export async function evaluateStakeholderRules(params: {
  productId: string;
  event: string;
  subjectName: string;
  processLabel: string;
  dealId?: string | null;
}): Promise<{ notified: number }> {
  const rules = await prisma.stakeholderRule.findMany({
    where: { productId: params.productId, event: params.event, enabled: true },
    select: { id: true, role: true, templateRef: true },
  });
  if (rules.length === 0) return { notified: 0 };

  const roles = [...new Set(rules.map((r) => r.role))];
  const stakeholders = await prisma.productStakeholder.findMany({
    where: { productId: params.productId, role: { in: roles } },
    select: {
      id: true,
      contactId: true,
      role: true,
      channelPreference: true,
      contact: { select: { id: true, name: true } },
    },
  });

  let notified = 0;
  for (const st of stakeholders) {
    const text =
      `Olá, ${st.contact.name}. Atualização do processo "${params.processLabel}": ` +
      `${params.subjectName}.`;
    try {
      await deliver(st, text, params.dealId);
      notified++;
    } catch (err) {
      log.warn("evaluateStakeholderRules falhou:", err);
    }
  }

  if (params.dealId) {
    void logEvent({
      type: "STAKEHOLDER_RULES_EVALUATED",
      actorType: "AUTOMATION",
      entityType: "DEAL",
      entityId: params.dealId,
      dealId: params.dealId,
      meta: {
        event: params.event,
        rules: rules.length,
        notified,
        templateRefs: rules.map((r) => r.templateRef).filter(Boolean),
      },
    });
  }
  return { notified };
}

/** Solicita feedback aos stakeholders `notifyForFeedback`. */
export async function requestStakeholderFeedback(
  params: NotifyParams,
): Promise<{ requested: number }> {
  const stakeholders = await loadStakeholders(params, "notifyForFeedback");
  let requested = 0;
  for (const st of stakeholders) {
    const text =
      `Olá, ${st.contact.name}. Poderia dar seu feedback sobre ${params.subjectName} ` +
      `no processo "${params.processLabel}"? Responda esta mensagem para registrarmos.`;
    try {
      await deliver(st, text, params.dealId);
      requested++;
    } catch (err) {
      log.warn("requestStakeholderFeedback falhou:", err);
    }
  }
  if (params.dealId) {
    void logEvent({
      type: "STAKEHOLDER_FEEDBACK_REQUESTED",
      actorType: "AUTOMATION",
      entityType: "DEAL",
      entityId: params.dealId,
      dealId: params.dealId,
      meta: { requested, total: stakeholders.length },
    });
  }
  return { requested };
}
