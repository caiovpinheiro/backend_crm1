/**
 * 1º atendimento por agente de IA (motor v2).
 *
 * Conversa que chega sem responsável vai para o agente v2 do canal (ou o
 * primeiro que atende qualquer canal), salvo quando ela é de pessoa:
 *  - transferida por um agente para pessoa e ainda aberta (estado "pessoa");
 *  - pendente na fila de distribuição (em qualquer horário);
 *  - com responsável humano que já falou nela ou foi atribuído nela.
 * Herança de responsável antigo que nunca falou nesta conversa não segura:
 * a IA assume. Regras genéricas; nada de funil, campanha ou intenção de
 * produto — isso é configuração de cada agente.
 */

import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import { getLogger } from "@/lib/logger";
import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { isAiAttendanceEnabled, releaseAiAssigneeIfDisabled } from "@/services/ai/attendance-gate";
import { isContactAllowedForAi } from "@/services/ai/phone-allowlist";
import { conversationHandedOffToHuman, pickAgentForConversation } from "@/services/ai-v2/agent-resolver";
import { humanWasAssignedInThisConversation } from "@/services/distribution/human-assignment-history";
import { keepHumanAfterAutomationClose } from "@/services/distribution/return-after-close";

const log = getLogger("ai-v2.first-attendance");

function logAi(event: string, payload: Record<string, unknown>) {
  log.info({ event, ...payload }, `[ai-attend] ${event}`);
}

/** Chave genérica `ai.firstAttendanceEnabled` (padrão ligado). */
async function isFirstAttendanceEnabled(): Promise<boolean> {
  try {
    const raw = await getOrgSetting("ai.firstAttendanceEnabled");
    if (raw == null || raw === "") return true;
    return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * Atribui a conversa ao agente v2 quando ela não é de pessoa.
 * @returns id do usuário IA que ficou com a conversa; null quando não se aplica.
 */
export async function tryAssignFirstAttendanceAi(args: {
  conversationId: string;
  contactId: string;
  assignedToId?: string | null;
  userMessage?: string | null;
}): Promise<string | null> {
  if (!(await isAiAttendanceEnabled())) {
    const released = await releaseAiAssigneeIfDisabled({ conversationId: args.conversationId, contactId: args.contactId });
    logAi("first_attendance_kill_switch", { conversationId: args.conversationId, released });
    return null;
  }
  if (!(await isFirstAttendanceEnabled())) {
    logAi("first_attendance_disabled", { conversationId: args.conversationId });
    return null;
  }

  // "Ok", "obrigado" soltos não abrem atendimento de IA.
  if (args.userMessage != null && args.userMessage.trim() !== "") {
    try {
      const { shouldSkipIdleInboundAutomation } = await import("@/services/ai/idle-inbound");
      if (await shouldSkipIdleInboundAutomation({ content: args.userMessage })) {
        logAi("first_attendance_skip_idle_inbound", { conversationId: args.conversationId, contactId: args.contactId });
        return null;
      }
    } catch (e) {
      log.error({ err: e }, "[ai-v2] idle inbound check failed");
    }
  }

  try {
    if (!(await isContactAllowedForAi(args.contactId))) {
      logAi("first_attendance_skip_allowlist", { conversationId: args.conversationId, contactId: args.contactId });
      return null;
    }
  } catch (e) {
    log.error({ err: e }, "[ai-v2] first_attendance allowlist failed — skipping");
    return null;
  }

  try {
    const keptHumanId = await keepHumanAfterAutomationClose({ conversationId: args.conversationId, contactId: args.contactId });
    if (keptHumanId) {
      logAi("first_attendance_keep_human_after_automation_close", { conversationId: args.conversationId, contactId: args.contactId, humanUserId: keptHumanId });
      return null;
    }
  } catch (e) {
    log.error({ err: e }, "[ai-v2] keepHumanAfterAutomationClose failed");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      id: true,
      organizationId: true,
      assignedToId: true,
      contactId: true,
      hasHumanReply: true,
      closedAt: true,
      channelId: true,
      contact: { select: { phone: true } },
      channelRef: { select: { status: true, name: true, phoneNumber: true, config: true } },
      assignedTo: { select: { type: true } },
    },
  });
  if (!conv) return null;
  const contactId = conv.contactId ?? args.contactId;
  if (!contactId) return null;

  if (isRetiredWhatsAppChannel(conv.channelRef)) {
    logAi("first_attendance_skip_retired_channel", { conversationId: conv.id, channel: conv.channelRef?.name });
    return null;
  }
  if (conv.channelRef && conv.channelRef.status !== "CONNECTED") {
    logAi("first_attendance_skip_channel_off", { conversationId: conv.id, channel: conv.channelRef.name, status: conv.channelRef.status });
    return null;
  }

  // Já está na IA: não mexe.
  if (conv.assignedToId && conv.assignedTo?.type === "AI") return conv.assignedToId;

  // Fluxo de automação pausado aguardando resposta do contato: a IA não
  // assume por cima.
  try {
    const { getContactActiveContexts } = await import("@/services/automation-context");
    const activeCtxs = await getContactActiveContexts(contactId);
    if (activeCtxs.length > 0) {
      logAi("first_attendance_skip_automation_waiting", { conversationId: conv.id, contactId, contexts: activeCtxs.length });
      return null;
    }
  } catch (e) {
    log.error({ err: e }, "[ai-v2] first_attendance automation-context check failed — skipping");
    return null;
  }

  // Transferida por um agente para pessoa e ainda aberta: fica de pessoa,
  // dentro ou fora do horário.
  if (await conversationHandedOffToHuman({ id: conv.id, closedAt: conv.closedAt })) {
    logAi("first_attendance_skip_handed_off", { conversationId: conv.id, contactId });
    return null;
  }

  // Pendente na fila de pessoas: sem exceções.
  const waitingHuman = await prisma.distributionPending.findFirst({
    where: { status: "PENDING", OR: [{ conversationId: conv.id }, { contactId }] },
    select: { id: true, triggerSource: true },
  });
  if (waitingHuman) {
    logAi("first_attendance_skip_pending_human", { conversationId: conv.id, contactId, pendingId: waitingHuman.id, triggerSource: waitingHuman.triggerSource });
    return null;
  }

  if (conv.assignedToId && conv.assignedTo?.type === "HUMAN") {
    if (conv.hasHumanReply) {
      logAi("first_attendance_skip_human_replied", { conversationId: conv.id, humanUserId: conv.assignedToId });
      return null;
    }
    if (await humanWasAssignedInThisConversation(conv.id, conv.assignedToId)) {
      logAi("first_attendance_skip_human_assigned_here", { conversationId: conv.id, humanUserId: conv.assignedToId });
      return null;
    }
    // Herança de responsável antigo que nunca falou aqui: a IA assume.
  }

  const agents = await prisma.user.findMany({
    where: { organizationId: conv.organizationId, type: "AI", aiAgentConfig: { is: { active: true, engine: "simple" } } },
    select: { id: true, aiAgentConfig: { select: { id: true, simpleConfig: true } } },
    orderBy: { createdAt: "asc" },
  });
  const agent = pickAgentForConversation(agents, conv.channelId ?? null, conv.contact?.phone ?? null);
  if (!agent) {
    logAi("first_attendance_no_agent", { conversationId: conv.id });
    return null;
  }

  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({ where: { id: conv.id }, data: { assignedToId: agent.id }, select: { id: true } });
    await tx.contact.update({ where: { id: contactId }, data: { assignedToId: agent.id }, select: { id: true } });
    await tx.deal.updateMany({ where: { contactId, status: "OPEN" }, data: { ownerId: agent.id } });
  });
  logAi("first_attendance_assigned", { conversationId: conv.id, contactId, aiUserId: agent.id });
  return agent.id;
}

/**
 * Garante o 1º atendimento em toda mensagem recebida (não só na criação
 * do ticket). Com o atendimento por IA desligado na org, solta o
 * responsável IA e manda o ticket para a distribuição de pessoas.
 */
export async function ensureInboundAiAttendance(args: {
  conversationId: string;
  contactId: string;
  userMessage?: string | null;
}): Promise<string | null> {
  try {
    if (!(await isAiAttendanceEnabled())) {
      await releaseAiAssigneeIfDisabled({ conversationId: args.conversationId, contactId: args.contactId });
      const { maybeDistributeNewInboundTicket } = await import("@/services/distribution");
      await maybeDistributeNewInboundTicket({ conversationId: args.conversationId, contactId: args.contactId, assignedToId: null });
      return null;
    }
    return await tryAssignFirstAttendanceAi({
      conversationId: args.conversationId,
      contactId: args.contactId,
      assignedToId: null,
      userMessage: args.userMessage,
    });
  } catch (e) {
    log.error({ err: e }, "[ai-v2] ensureInboundAiAttendance failed");
    return null;
  }
}
