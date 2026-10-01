/**
 * Primeiro atendimento por Agente IA.
 *
 * Regras:
 *  - Escopo de funil: pipelineId do agente ou org setting
 *    `ai.firstAttendancePipelineIds`. Sem nenhum, atende qualquer funil.
 *  - Sem responsável humano → IA assume conversa + contato + deals OPEN.
 *  - Com responsável humano já atribuído → devolve o chat a esse humano
 *    (não “rouba” nem deixa na IA).
 *  - Desliga com `ai.firstAttendanceEnabled=false`.
 */


import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import { getOrgIdOrNull } from "@/lib/request-context";
import {
  isAiAttendanceEnabled,
  releaseAiAssigneeIfDisabled,
} from "@/services/ai/attendance-gate";
import { isContactAllowedForAi } from "@/services/ai/phone-allowlist";
import { humanWasAssignedInThisConversation } from "@/services/distribution/human-assignment-history";
import { keepHumanAfterAutomationClose } from "@/services/distribution/return-after-close";
import {
  humanQueueContextFromAgent,
  isHumanAttendanceWindowOpen,
} from "@/services/ai/human-queue-policy";

function logAi(event: string, payload: Record<string, unknown>) {
  console.info(
    "[ai-attend]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

async function isFirstAttendanceEnabled(): Promise<boolean> {
  try {
    const raw = await getOrgSetting("ai.firstAttendanceEnabled");
    if (raw == null || raw === "") return true;
    return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
  } catch {
    return true;
  }
}

type FirstAttendanceAgent = {
  userId: string;
  pipelineId: string | null;
  businessHours: unknown;
};

async function resolveFirstAttendanceAgent(): Promise<FirstAttendanceAgent | null> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;

  try {
    const forced = await getOrgSetting("ai.firstAttendanceUserId");
    if (forced?.trim()) {
      const u = await prisma.user.findFirst({
        where: {
          id: forced.trim(),
          organizationId: orgId,
          type: "AI",
          aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
        },
        select: {
          id: true,
          aiAgentConfig: { select: { pipelineId: true, businessHours: true } },
        },
      });
      if (u) {
        return {
          userId: u.id,
          pipelineId: u.aiAgentConfig?.pipelineId ?? null,
          businessHours: u.aiAgentConfig?.businessHours ?? null,
        };
      }
    }
  } catch {
    /* fora de RequestContext */
  }

  const preferred = await prisma.aIAgentConfig.findFirst({
    where: {
      organizationId: orgId,
      active: true,
      autonomyMode: "AUTONOMOUS",
      archetype: "ATENDIMENTO",
    },
    orderBy: { createdAt: "asc" },
    select: { userId: true, pipelineId: true, businessHours: true },
  });
  if (preferred) return preferred;

  const any = await prisma.aIAgentConfig.findFirst({
    where: {
      organizationId: orgId,
      active: true,
      autonomyMode: "AUTONOMOUS",
    },
    orderBy: { createdAt: "asc" },
    select: { userId: true, pipelineId: true, businessHours: true },
  });
  return any ?? null;
}

async function resolveConfiguredPipelineIds(
  agentPipelineId: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  if (agentPipelineId) ids.add(agentPipelineId);
  try {
    const raw = await getOrgSetting("ai.firstAttendancePipelineIds");
    if (raw?.trim()) {
      for (const part of raw.split(/[,;\s]+/)) {
        const id = part.trim();
        if (id) ids.add(id);
      }
    }
  } catch {
    /* ignore */
  }
  return [...ids];
}

/**
 * Contato está no escopo do agente se tem deal OPEN cujo pipeline está na
 * lista configurada (agente / org setting). Sem lista, qualquer funil.
 *
 * Importante: `Deal` NÃO tem `pipelineId` direto — o funil vem de
 * `deal.stage.pipeline`. Select errado quebrava o 1º atendimento em
 * runtime (catch silencioso → ninguém recebia a IA).
 */
async function isContactInAgentScope(
  contactId: string,
  agentPipelineId: string | null,
): Promise<boolean> {
  const configured = await resolveConfiguredPipelineIds(agentPipelineId);
  const openDeals = await prisma.deal.findMany({
    where: { contactId, status: "OPEN" },
    select: {
      id: true,
      stage: {
        select: {
          name: true,
          pipeline: { select: { id: true, name: true } },
        },
      },
    },
  });
  // Sem deal (lead novo): o agente atende. Sem isso o inbox recebia o
  // "oi" e a IA nunca assumia.
  if (openDeals.length === 0) return true;

  for (const d of openDeals) {
    const pipe = d.stage?.pipeline;
    if (pipe && configured.includes(pipe.id)) return true;
  }
  // Sem restrição configurada, o agente atende qualquer funil.
  return configured.length === 0;
}

/**
 * Dono humano atual (contato ou deal OPEN) — se existir, o chat volta pra ele.
 */
async function findExistingHumanOwner(
  contactId: string,
): Promise<string | null> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (contact?.assignedToId && contact.assignedTo?.type === "HUMAN") {
    return contact.assignedToId;
  }

  const deal = await prisma.deal.findFirst({
    where: {
      contactId,
      status: "OPEN",
      ownerId: { not: null },
      owner: { type: "HUMAN" },
    },
    orderBy: { updatedAt: "desc" },
    select: { ownerId: true },
  });
  return deal?.ownerId ?? null;
}

async function assignConversationToHuman(args: {
  conversationId: string;
  contactId: string;
  humanUserId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { assignedToId: args.humanUserId },
      select: { id: true },
    });
    await tx.contact.update({
      where: { id: args.contactId },
      data: { assignedToId: args.humanUserId },
      select: { id: true, assignedToId: true },
    });
    await tx.deal.updateMany({
      where: { contactId: args.contactId, status: "OPEN" },
      data: { ownerId: args.humanUserId },
    });
  });
}

/**
 * Se a conversa está sem assignee humano e está no escopo do agente,
 * atribui ao agente de 1º atendimento.
 * Se já há humano responsável (e respondeu / está no chat), não rouba.
 * @returns userId da IA se atribuiu; null se não aplicável.
 */
export async function tryAssignFirstAttendanceAi(args: {
  conversationId: string;
  contactId: string;
  assignedToId?: string | null;
  userMessage?: string | null;
}): Promise<string | null> {
  // Agente resolvido UMA vez, sob demanda: os early-returns não pagam a query.
  let agentPromise: Promise<FirstAttendanceAgent | null> | null = null;
  const agentOnce = () => (agentPromise ??= resolveFirstAttendanceAgent());

  if (!(await isAiAttendanceEnabled())) {
    const released = await releaseAiAssigneeIfDisabled({
      conversationId: args.conversationId,
      contactId: args.contactId,
    });
    logAi("first_attendance_kill_switch", {
      conversationId: args.conversationId,
      released,
    });
    return null;
  }

  if (!(await isFirstAttendanceEnabled())) {
    logAi("first_attendance_disabled", {
      conversationId: args.conversationId,
    });
    return null;
  }

  if (args.userMessage != null && args.userMessage.trim() !== "") {
    try {
      const { shouldSkipIdleInboundAutomation } = await import(
        "@/services/ai/idle-inbound"
      );
      if (
        await shouldSkipIdleInboundAutomation({
          content: args.userMessage,
        })
      ) {
        logAi("first_attendance_skip_idle_inbound", {
          conversationId: args.conversationId,
          contactId: args.contactId,
        });
        return null;
      }
    } catch (e) {
      console.error("[ai] idle inbound check failed", e);
    }
  }

  try {
    const allowed = await isContactAllowedForAi(args.contactId);
    if (!allowed) {
      logAi("first_attendance_skip_allowlist", {
        conversationId: args.conversationId,
        contactId: args.contactId,
      });
      return null;
    }
  } catch (e) {
    console.error("[ai] first_attendance allowlist failed — skipping", e);
    return null;
  }

  try {
    const keptHumanId = await keepHumanAfterAutomationClose({
      conversationId: args.conversationId,
      contactId: args.contactId,
    });
    if (keptHumanId) {
      logAi("first_attendance_keep_human_after_automation_close", {
        conversationId: args.conversationId,
        contactId: args.contactId,
        humanUserId: keptHumanId,
      });
      return null;
    }
  } catch (e) {
    console.error("[ai] keepHumanAfterAutomationClose failed", e);
  }

  try {
    const convCh = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: {
        channelRef: {
          select: { status: true, name: true, phoneNumber: true, config: true },
        },
      },
    });
    if (isRetiredWhatsAppChannel(convCh?.channelRef)) {
      logAi("first_attendance_skip_retired_channel", {
        conversationId: args.conversationId,
        contactId: args.contactId,
        channel: convCh?.channelRef?.name,
      });
      return null;
    }
    if (convCh?.channelRef && convCh.channelRef.status !== "CONNECTED") {
      logAi("first_attendance_skip_channel_off", {
        conversationId: args.conversationId,
        contactId: args.contactId,
        channel: convCh.channelRef.name,
        status: convCh.channelRef.status,
      });
      return null;
    }
  } catch (e) {
    console.error("[ai] first_attendance channel status check failed — skipping", e);
    return null;
  }

  // Automação pausada aguardando resposta do contato (ex.: template com
  // botões): a IA NÃO assume, pra não matar o salesbot.
  try {
    const { getContactActiveContexts } = await import(
      "@/services/automation-context"
    );
    const activeCtxs = await getContactActiveContexts(args.contactId);
    if (activeCtxs.length > 0) {
      logAi("first_attendance_skip_automation_waiting", {
        conversationId: args.conversationId,
        contactId: args.contactId,
        contexts: activeCtxs.length,
      });
      return null;
    }
  } catch (e) {
    console.error("[ai] first_attendance automation-context check failed — skipping", e);
    return null;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      assignedToId: true,
      contactId: true,
      hasHumanReply: true,
      departmentId: true,
      aiGreetedAt: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conv) return null;

  const contactId = conv.contactId ?? args.contactId;
  if (!contactId) return null;

  // Já está na IA: não desatribui. Handoff para depto já zera assignedToId
  // no próprio passo; o bloco antigo (clear_ai_dept_handoff) apagava a IA
  // no próximo "oi" depois do operador devolver o ticket ao agente.
  if (conv.assignedToId && conv.assignedTo?.type === "AI") {
    return conv.assignedToId;
  }

  // Já enfileirado para humano (handoff IA) → NÃO reassumir com a IA
  // (senão reenvia saudação e "some" com o pedido de atendente).
  const waitingHuman = await prisma.distributionPending.findFirst({
    where: {
      status: "PENDING",
      OR: [
        { conversationId: args.conversationId },
        { contactId },
      ],
    },
    select: { id: true, triggerSource: true },
  });
  if (waitingHuman) {
    const agent = await agentOnce();
    // Fora do horário de atendente humano DESTE agente a IA segue.
    const keepAiDespitePending = !isHumanAttendanceWindowOpen(
      new Date(),
      humanQueueContextFromAgent({ businessHours: agent?.businessHours }),
    );
    if (!keepAiDespitePending) {
      logAi("first_attendance_skip_pending_human", {
        conversationId: args.conversationId,
        contactId,
        pendingId: waitingHuman.id,
        triggerSource: waitingHuman.triggerSource,
      });
      return null;
    }
    logAi("first_attendance_keep_ai_despite_pending", {
      conversationId: args.conversationId,
      contactId,
      pendingId: waitingHuman.id,
      triggerSource: waitingHuman.triggerSource,
    });
  }

  // Handoff RESOLVIDO (últimas 24h) não bloqueia: o operador já devolveu
  // ao agente ou o ticket está livre. Só PENDING (acima) segura a fila.

  // Humano já respondeu nesta conversa → não rouba.
  if (conv.hasHumanReply && conv.assignedTo?.type === "HUMAN") {
    logAi("first_attendance_skip_human_replied", {
      conversationId: args.conversationId,
      humanUserId: conv.assignedToId,
    });
    return null;
  }

  // Agente desligado (nenhum AUTONOMOUS ativo): não tira o humano para
  // "abrir espaço". A limpeza só existe quando há quem assumir.
  const agent = await agentOnce();
  if (!agent) {
    logAi("first_attendance_no_agent", {
      conversationId: args.conversationId,
    });
    return null;
  }

  // Humano no chat SEM reply → libera para a IA (1º atendimento).
  // Herança de responsável antigo não deve bloquear o agente.
  if (conv.assignedToId && conv.assignedTo?.type === "HUMAN" && !conv.hasHumanReply) {
    // ...mas só quando é HERANÇA mesmo. Se o consultor foi atribuído NESTA
    // conversa (distribuição/transferência), ele fica: a saudação de
    // `lead_distributed` sai como bot e não marca `hasHumanReply`, então
    // sem esta checagem o próximo inbound do aluno tirava o dono do ticket.
    if (
      await humanWasAssignedInThisConversation(
        args.conversationId,
        conv.assignedToId,
      )
    ) {
      logAi("first_attendance_keep_assigned_human", {
        conversationId: args.conversationId,
        humanUserId: conv.assignedToId,
      });
      return null;
    }
    logAi("first_attendance_clear_inherited_human", {
      conversationId: args.conversationId,
      humanUserId: conv.assignedToId,
    });
    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: args.conversationId },
        data: { assignedToId: null },
        select: { id: true },
      });
      await tx.contact.update({
        where: { id: contactId },
        data: { assignedToId: null },
        select: { id: true, assignedToId: true },
      });
    });
  }

  const orgId = getOrgIdOrNull();
  if (!orgId) return null;
  const agentInOrg = await prisma.user.findFirst({
    where: { id: agent.userId, organizationId: orgId, type: "AI" },
    select: { id: true },
  });
  if (!agentInOrg) {
    logAi("first_attendance_skip_foreign_agent", {
      conversationId: args.conversationId,
      aiUserId: agent.userId,
      orgId,
    });
    return null;
  }

  const inScope = await isContactInAgentScope(contactId, agent.pipelineId);
  if (!inScope) {
    // Fora do escopo: se havia humano no contato/deal, devolve.
    const humanOwner =
      (args.assignedToId
        ? (
            await prisma.user.findUnique({
              where: { id: args.assignedToId },
              select: { type: true },
            })
          )?.type === "HUMAN"
          ? args.assignedToId
          : null
        : null) ?? (await findExistingHumanOwner(contactId));
    if (humanOwner) {
      await assignConversationToHuman({
        conversationId: args.conversationId,
        contactId,
        humanUserId: humanOwner,
      });
      logAi("first_attendance_restored_human_out_of_scope", {
        conversationId: args.conversationId,
        contactId,
        humanUserId: humanOwner,
      });
    } else {
      logAi("first_attendance_skip_out_of_scope", {
        conversationId: args.conversationId,
        contactId,
      });
    }
    return null;
  }

  const aiUserId = agent.userId;

  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: {
        assignedToId: aiUserId,
        // Não zera aiGreetedAt aqui: após handoff o marker pode já ter
        // sido limpo por propagate, mas o bot já falou — reabrir com
        // aiGreetedAt=null reenvia openingMessage no "Ok".
      },
      select: { id: true },
    });
    await tx.contact.update({
      where: { id: contactId },
      data: { assignedToId: aiUserId },
      select: { id: true, assignedToId: true },
    });
    await tx.deal.updateMany({
      where: { contactId, status: "OPEN" },
      data: { ownerId: aiUserId },
    });
  });

  logAi("first_attendance_assigned", {
    conversationId: args.conversationId,
    contactId,
    aiUserId,
  });
  return aiUserId;
}

/**
 * Garante 1º atendimento IA em toda mensagem inbound (não só na criação
 * do ticket). Chamar ANTES de fireTrigger/salesbot para silenciar INICIO-PIPE.
 */
export async function ensureInboundAiAttendance(args: {
  conversationId: string;
  contactId: string;
  userMessage?: string | null;
}): Promise<string | null> {
  try {
    if (!(await isAiAttendanceEnabled())) {
      await releaseAiAssigneeIfDisabled({
        conversationId: args.conversationId,
        contactId: args.contactId,
      });
      const { maybeDistributeNewInboundTicket } = await import(
        "@/services/distribution"
      );
      await maybeDistributeNewInboundTicket({
        conversationId: args.conversationId,
        contactId: args.contactId,
        assignedToId: null,
      });
      return null;
    }
    return await tryAssignFirstAttendanceAi({
      conversationId: args.conversationId,
      contactId: args.contactId,
      assignedToId: null,
      userMessage: args.userMessage,
    });
  } catch (e) {
    console.error("[ai] ensureInboundAiAttendance failed", e);
    return null;
  }
}
