/**
 * Glue entre o webhook Meta/Baileys e o runner de agentes de IA.
 *
 * Estratégia: quando uma mensagem chega (direction=in) e a conversa
 * está atribuída a um User com type=AI, disparamos o runner.
 *
 * Antes de chamar o LLM, aplicamos os CONTROLES DE PILOTING:
 *
 *   1. Business hours — expediente do consultor (Pilotagem). A IA
 *      continua; a fila humana usa `offHoursMessage` / `handoffMessage`.
 *   2. Keyword handoff — se a mensagem do cliente bate com alguma
 *      `keywordHandoffs`, transferimos imediatamente pra humano
 *      (sem LLM).
 *   3. Opening message — se é a PRIMEIRA vez que o agente fala nesta
 *      conversa e existe uma saudação configurada, enviamos ela
 *      antes de processar a mensagem do cliente com o LLM.
 *   4. Só aí chamamos `runAgent`.
 *
 *  - `autonomyMode=AUTONOMOUS`: enviamos a resposta direto pelo
 *    WhatsApp e registramos uma Message OUT com `authorType=bot` e
 *    `aiAgentUserId` marcando a autoria.
 *  - `autonomyMode=DRAFT`: registramos a resposta como mensagem
 *    privada (`isPrivate=true`, `messageType=ai_draft`) para o operador
 *    humano aprovar/editar/enviar pelo chat-window.
 *
 * Falhas são logadas mas nunca propagam: o webhook precisa responder
 * 200 pra Meta mesmo se o agente quebrar.
 */

import {
  buildNaturalAttendanceCloseReply,
  buildSoftCloseAfterNudgeReply,
  isIdleNudgeContent,
  rewriteMismatchedDaypartWish,
  userWantsSoftAiClose,
} from "@/services/ai/idle-followup";
import {
  parseAgentConfidence,
  shouldHandoffOnLowConfidence,
} from "@/services/ai/confidence";
import {
  buildAssignedConsultantNotice,
  buildHumanQueueWithHoursMessage,
  buildHumanUnavailableOfferMessage,
  humanAttendanceStartHint,
  isHumanAttendanceWindowOpen,
  isNearDuplicateBotText,
  messageLooksLikeHumanQueueNotice,
  userWantsAiContinue,
  userWantsHumanDistribution,
} from "@/services/ai/human-queue-policy";
import { debugInfo } from "@/lib/debug-log";
import { cancelAiReplyDebounce } from "@/services/ai/inbound-debounce";
import { getVerticalPack, runVerticalIntercepts } from "@/verticals";
import { recordInboxInterceptRun } from "@/services/ai/record-intercept-run";
import { runAgent } from "@/services/ai/runner";
import { sendAgentFollowUpMedia } from "@/services/ai/send-agent-media";

export type InboundAIArgs = {
  conversationId: string;
  contactId: string;
  userMessage: string;
  channel: "meta" | "baileys";
  /** Geração do debounce — se supersedida, aborta antes do envio. */
  generationId?: string;
  inboundMessageIds?: string[];
};

function logAi(event: string, payload: Record<string, unknown>) {
  debugInfo(
    "[ai-attend]",
    () => JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

/** Cumprimento curto (oi/olá/bom dia...) sem pedido útil. */
function isBareGreetingMessage(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.length > 48) return false;
  if (
    /^(oi+|ol[aá]+|oie+|hey|hello|bom dia|boa tarde|boa noite)([,.!\s]+tudo bem)?[!?.…]*$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  const n = trimmed
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n || n.length > 40) return false;
  return /^(oi+|ola+|oie+|hey|hello|bom dia|boa tarde|boa noite)( tudo bem)?$/.test(
    n,
  );
}

/** "oi", "??", "consegue me ajudar" — a IA atende; não é fila humana. */
function isAcademicSelfServeTurn(
  raw: string,
  ops?: Record<string, any> | null,
): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  if (/^\?+$/.test(trimmed)) return true;
  if (isBareGreetingMessage(trimmed)) return true;
  if (ops?.isFirstAccessIntent?.(trimmed)) return true;
  if (ops?.isFirstAccessStuckIntent?.(trimmed)) return true;
  if (ops?.isAvaOrDisciplinesIntent?.(trimmed)) return true;
  if (userWantsAiContinue(trimmed)) return true;
  return false;
}

function buildAcademicStayWithYouMessage(): string {
  return (
    "Oi! Tô aqui. Pode me dizer o que você precisa — " +
    "portal, senha, Blackboard, prova, documento…"
  );
}

function buildRetentionHandoffMessage(
  now = new Date(),
  policy?: InboxPolicy | null,
  businessHours?: BusinessHoursConfig | null,
): string {
  if (policy?.retentionHandoffMessage) return policy.retentionHandoffMessage;
  if (isHumanAttendanceWindowOpen(now, businessHours)) {
    return (
      "Entendi! Sobre *trancamento/cancelamento* já pedi para o setor de *Retenção* " +
      "te atender. Assim que um(a) consultor(a) puder, continua com você. " +
      "Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo 💛"
    );
  }
  const { startHour, dayLabel } = humanAttendanceStartHint(now);
  return (
    `Entendi! Sobre *trancamento/cancelamento* já registrei seu pedido com *Retenção*. ` +
    `O atendimento humano retoma às *${startHour}h* ${dayLabel}. ` +
    `Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo 💛`
  );
}

/** Mensagem genérica de fila — texto e horário vêm da Pilotagem. */
function buildGenericQueueHandoffMessage(
  now = new Date(),
  policy?: InboxPolicy | null,
  businessHours?: BusinessHoursConfig | null,
): string {
  return buildHumanUnavailableOfferMessage(now, {
    businessHours,
    handoffMessage: policy?.handoffMessage,
    offHoursMessage: businessHours?.offHoursMessage,
  });
}

function studentNoticeAfterHandoff(gotHuman: boolean, queueText: string): string {
  return gotHuman ? buildAssignedConsultantNotice() : queueText;
}

/**
 * Aluno encerrou o assunto e o agente se despediu → fecha o ticket.
 * Sem isso a conversa fica na fila da IA depois do atendimento pronto.
 */
async function closeAfterFarewellIfNeeded(args: {
  conversationId: string;
  contactId: string;
  userMessage: string;
  replyText: string;
  packOps?: Record<string, any> | null;
}): Promise<void> {
  const ops = args.packOps ?? null;
  if (
    !ops?.shouldCloseAfterAgentFarewell?.({
      userMessage: args.userMessage,
      replyText: args.replyText,
    })
  ) {
    return;
  }
  const gate = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { status: true, assignedTo: { select: { type: true } } },
  });
  if (gate?.status === "RESOLVED" || gate?.assignedTo?.type !== "AI") return;
  const closed = await ops.closeAiOnlyConversation?.({
    conversationId: args.conversationId,
    contactId: args.contactId,
    allowAfterHumanReply: true,
    reason: "Atendimento concluído — aluno se despediu e o agente encerrou",
  }).catch(() => ({ closed: false, reason: "ERROR" }));
  if (closed?.closed) {
    cancelAiReplyDebounce(args.conversationId, "agent_farewell");
    logAi("closed", {
      conversationId: args.conversationId,
      reason: "agent_farewell",
    });
  }
}
/** Após distribuição bem-sucedida a saudação fica com a automação (como responsável). */
async function conversationAssignedToHuman(
  conversationId: string,
): Promise<boolean> {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { assignedTo: { select: { type: true } } },
  });
  return c?.assignedTo?.type === "HUMAN";
}

function stripConfidenceTag(text: string): string {
  return parseAgentConfidence(text).text.trim();
}

const RUN_FAILURE_WINDOW_MS = 30 * 60 * 1000;

/** Erro que retry não resolve: chave, permissão, cota, billing. */
function isPermanentRunFailure(error?: string | null): boolean {
  const msg = (error ?? "").toLowerCase();
  if (!msg) return false;
  return /api[_\s-]?key|unauthorized|forbidden|401|403|invalid_api_key|insufficient_quota|quota|billing|credit|permission/.test(
    msg,
  );
}

/**
 * Blip isolado de LLM fica na IA para retry. Chave/cota inválida ou falha
 * repetida deixaria o aluno sem ninguém — nesse caso distribui.
 */
async function shouldDistributeAfterRunFailure(args: {
  conversationId: string;
  error?: string | null;
}): Promise<boolean> {
  if (isPermanentRunFailure(args.error)) return true;
  const failures = await prisma.aIAgentRun.count({
    where: {
      conversationId: args.conversationId,
      status: "FAILED",
      createdAt: { gte: new Date(Date.now() - RUN_FAILURE_WINDOW_MS) },
    },
  });
  return failures >= 2;
}

function runHadTransferTools(
  toolCalls: Array<{ name: string }> | undefined,
): boolean {
  if (!toolCalls?.length) return false;
  return toolCalls.some((c) =>
    ["transfer_to_human", "transfer_to_department", "execute_distribution"].includes(
      c.name,
    ),
  );
}

/**
 * Confirma que a conversa ainda está com um agente IA ativo e que
 * nenhum humano respondeu depois do início do processamento.
 */
export async function assertAiStillAuthorized(args: {
  conversationId: string;
  expectedAgentUserId: string;
  generationId?: string;
  since?: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (args.generationId) {
    const current = await cache.get<string>(`ai:gen:${args.conversationId}`);
    if (current && current !== args.generationId) {
      return { ok: false, reason: "generation_superseded" };
    }
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      assignedToId: true,
      hasHumanReply: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conversation?.assignedToId) {
    return { ok: false, reason: "unassigned" };
  }
  if (conversation.assignedToId !== args.expectedAgentUserId) {
    return { ok: false, reason: "assignee_changed" };
  }
  if (conversation.assignedTo?.type !== "AI") {
    return { ok: false, reason: "assignee_not_ai" };
  }

  // Humano falou depois do início deste processamento?
  if (args.since) {
    const humanOut = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        direction: "out",
        authorType: "human",
        isPrivate: false,
        createdAt: { gte: args.since },
      },
      select: { id: true },
    });
    if (humanOut) return { ok: false, reason: "human_replied_during_run" };
  }

  return { ok: true };
}

export async function maybeReplyAsAIAgent(args: InboundAIArgs): Promise<void> {
  const startedAt = new Date();
  try {
    // Defesa em profundidade: nunca envia se telefone fora da allowlist.
    try {
      const allowed = await isContactAllowedForAi(args.contactId);
      if (!allowed) {
        logAi("blocked", {
          conversationId: args.conversationId,
          contactId: args.contactId,
          reason: "phone_allowlist",
        });
        return;
      }
    } catch (e) {
      console.error("[ai] phone allowlist in maybeReply — blocking", e);
      return;
    }

    let conversation = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: {
        id: true,
        assignedToId: true,
        contactId: true,
        hasHumanReply: true,
        channelRef: {
          select: {
            id: true,
            config: true,
            status: true,
            name: true,
            phoneNumber: true,
          },
        },
      },
    });
    if (isRetiredWhatsAppChannel(conversation?.channelRef)) {
      logAi("blocked", {
        conversationId: args.conversationId,
        contactId: args.contactId,
        reason: "retired_whatsapp_channel",
        channel: conversation?.channelRef?.name,
      });
      return;
    }
    if (
      conversation?.channelRef &&
      conversation.channelRef.status !== "CONNECTED"
    ) {
      logAi("blocked", {
        conversationId: args.conversationId,
        contactId: args.contactId,
        reason: "channel_not_connected",
        channel: conversation.channelRef.name,
        status: conversation.channelRef.status,
      });
      return;
    }

    // Vertical pack — pre_assignee (first_access → greeting_self_serve)
    {
      const earlyPack = await resolveInboxVerticalPack(conversation);
      if (earlyPack) {
        const env = makeInboxInterceptEnv({
          args,
          conversation,
          logAi,
          startedAt,
          helpers: {
            recordInboxInterceptRun,
            sendAgentMessage,
            isBareGreetingMessage,
            isAcademicSelfServeTurn: (raw: string) =>
              isAcademicSelfServeTurn(raw, earlyPack.ops),
            buildAcademicStayWithYouMessage,
            buildRetentionHandoffMessage,
            buildGenericQueueHandoffMessage,
            studentNoticeAfterHandoff,
            conversationAssignedToHuman,
            cancelAiReplyDebounce,
            assertAiStillAuthorized,
            hasAgentGreetedInCurrentAssignment,
            markAgentGreetedNow,
            delay,
          },
        });
        const hit = await runVerticalIntercepts(earlyPack, {
          phase: "pre_assignee",
          env,
        });
        if (env.conversation) conversation = env.conversation;
        if (hit?.handled) return;
      }
    }

    if (!conversation?.assignedToId) {
      // Sem responsável: se está na fila de distribuição (handoff IA),
      // tenta redistribuir; se não houver humano, oferece continuar com a IA
      // (exceto pedido explícito de fila/humano → avisa horário e mantém fila).
      const pending = await prisma.distributionPending.findFirst({
        where: {
          status: "PENDING",
          OR: [
            { conversationId: args.conversationId },
            { contactId: args.contactId },
          ],
        },
        select: { id: true, triggerSource: true },
        orderBy: { updatedAt: "desc" },
      });
      if (pending) {
        const { executeDistribution } = await import(
          "@/services/distribution"
        );
        const convDept = await prisma.conversation.findUnique({
          where: { id: args.conversationId },
          select: { departmentId: true },
        });
        await executeDistribution({
          dealId: null,
          contactId: args.contactId,
          conversationId: args.conversationId,
          triggerSource: "SYSTEM",
          departmentId: convDept?.departmentId ?? null,
          // Fronteira de departamento ESTRITA: lead roteado a um depto só é
          // distribuído a quem estiver disponível NAQUELE depto; se ninguém,
          // segue o fluxo abaixo (IA reassume/confirma). Sem departamento já
          // nasce org-wide.
          allowOrgWideFallback: false,
        }).catch(() => null);

        const stillOpen = await prisma.conversation.findUnique({
          where: { id: args.conversationId },
          select: {
            assignedToId: true,
            assignedTo: { select: { type: true } },
          },
        });
        if (stillOpen?.assignedTo?.type === "HUMAN") {
          logAi("waiting_queue_human_assigned", {
            conversationId: args.conversationId,
            pendingId: pending.id,
          });
          return;
        }

        const orgId = getOrgIdOrNull();
        const aiAgent = orgId
          ? await prisma.user.findFirst({
              where: {
                organizationId: orgId,
                type: "AI",
                aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
              },
              select: { id: true },
              orderBy: { createdAt: "asc" },
            })
          : null;
        if (!aiAgent) {
          logAi("waiting_queue_no_ai", {
            conversationId: args.conversationId,
            pendingId: pending.id,
          });
          return;
        }

        const lastBotOut = await prisma.message.findFirst({
          where: {
            conversationId: args.conversationId,
            direction: "out",
            authorType: "bot",
            isPrivate: false,
            messageType: { not: "note" },
          },
          orderBy: { createdAt: "desc" },
          select: { content: true },
        });

        if (userWantsHumanDistribution(args.userMessage)) {
          if (!messageLooksLikeHumanQueueNotice(lastBotOut?.content) ||
              !lastBotOut?.content?.includes("expediente inicia")) {
            await sendAgentMessage({
              conversationId: args.conversationId,
              contactId: args.contactId,
              agentUserId: aiAgent.id,
              autonomyMode: "AUTONOMOUS",
              text: buildHumanQueueWithHoursMessage(),
              channel: args.channel,
              kind: "text",
              bypassAssigneeCheck: true,
            }).catch(() => null);
          }
          logAi("waiting_queue_human_requested", {
            conversationId: args.conversationId,
            pendingId: pending.id,
          });
          return;
        }

        // Reassume IA (fila permanece) para continuar o atendimento se o aluno quiser.
        await prisma.$transaction(async (tx) => {
          await tx.conversation.update({
            where: { id: args.conversationId },
            data: { assignedToId: aiAgent.id },
          });
          await tx.contact.update({
            where: { id: args.contactId },
            data: { assignedToId: aiAgent.id },
          });
        });
        conversation = { ...conversation, assignedToId: aiAgent.id };

        // Não envia oferta aqui — a IA responde uma vez (evita bolha duplicada
        // oferta + LLM). Aviso de fila/indisponível fica no pós-handoff.
        logAi("waiting_queue_ai_continue", {
          conversationId: args.conversationId,
          pendingId: pending.id,
          alreadyNoticed: messageLooksLikeHumanQueueNotice(lastBotOut?.content),
        });
        // Fall through: IA responde normalmente.
      } else {
        logAi("blocked", {
          conversationId: args.conversationId,
          reason: "no_assignee",
        });
        return;
      }
    }

    const channelConfig = conversation.channelRef?.config as
      | Record<string, unknown>
      | null
      | undefined;
    const metaClient: MetaWhatsAppClient = metaClientFromConfig(channelConfig);

    const assignee = await prisma.user.findUnique({
      where: { id: conversation.assignedToId },
      select: {
        id: true,
        type: true,
        organizationId: true,
        aiAgentConfig: {
          select: {
            id: true,
            active: true,
            autonomyMode: true,
            openingMessage: true,
            openingDelayMs: true,
            keywordHandoffs: true,
            inactivityHandoffMode: true,
            inactivityHandoffUserId: true,
            businessHours: true,
            simulateTyping: true,
            typingPerCharMs: true,
            markMessagesRead: true,
            model: true,
            inboxPolicy: true,
            verticalPack: true,
          },
        },
      },
    });
    const orgId = getOrgIdOrNull();
    if (orgId && assignee && assignee.organizationId !== orgId) {
      logAi("blocked", {
        conversationId: args.conversationId,
        reason: "foreign_ai_assignee",
        agentUserId: assignee.id,
        agentOrgId: assignee.organizationId,
        orgId,
      });
      await prisma.conversation.update({
        where: { id: args.conversationId },
        data: { assignedToId: null },
      });
      await prisma.contact.update({
        where: { id: args.contactId },
        data: { assignedToId: null },
      });
      return;
    }
    if (!assignee || assignee.type !== "AI") {
      logAi("blocked", {
        conversationId: args.conversationId,
        reason: "assignee_not_ai",
      });
      return;
    }
    if (!assignee.aiAgentConfig?.active) {
      logAi("blocked", {
        conversationId: args.conversationId,
        reason: "agent_inactive",
        agentUserId: assignee.id,
      });
      return;
    }

    // Outbound humana *histórica* (ex.: "Bomzin" neste ticket) não silencia
    // a IA depois de transferência explícita. Humano falando *durante* o
    // run continua abortando em `assertAiStillAuthorized({ since })`.

    const cfg = assignee.aiAgentConfig;
    // Política editável na tela do agente. Campo vazio = defaults do
    // código, então agentes antigos seguem se comportando igual.
    const policy: InboxPolicy = normalizeInboxPolicy(
      cfg.inboxPolicy,
      cfg.verticalPack,
    );
    const hours = normalizeBusinessHours(cfg.businessHours);
    const humanBehavior = {
      simulateTyping: cfg.simulateTyping,
      typingPerCharMs: cfg.typingPerCharMs,
      markMessagesRead: cfg.markMessagesRead,
    };
    const agentPack = getVerticalPack(cfg.verticalPack ?? null);
    const packOps = agentPack?.ops ?? {};

    logAi("run_start", {
      conversationId: args.conversationId,
      contactId: args.contactId,
      channel: args.channel,
      generationId: args.generationId ?? null,
      inboundMessageIds: args.inboundMessageIds ?? [],
      model: cfg.model,
      agentUserId: assignee.id,
    });

    // Vertical pack — post_assignee (attendance_scope → greeting_only)
    let openDeal: { id: string } | null = null;
    let sentOpeningThisTurn = false;
    {
      if (agentPack) {
        const env = makeInboxInterceptEnv({
          args,
          conversation,
          logAi,
          startedAt,
          assignee,
          cfg,
          policy,
          hours,
          humanBehavior,
          helpers: {
            recordInboxInterceptRun,
            sendAgentMessage,
            isBareGreetingMessage,
            isAcademicSelfServeTurn: (raw: string) =>
              isAcademicSelfServeTurn(raw, packOps),
            buildAcademicStayWithYouMessage,
            buildRetentionHandoffMessage,
            buildGenericQueueHandoffMessage,
            studentNoticeAfterHandoff,
            conversationAssignedToHuman,
            cancelAiReplyDebounce,
            assertAiStillAuthorized,
            hasAgentGreetedInCurrentAssignment,
            markAgentGreetedNow,
            delay,
          },
        });
        const hit = await runVerticalIntercepts(agentPack, {
          phase: "post_assignee",
          env,
        });
        if (env.conversation) conversation = env.conversation;
        openDeal = env.openDeal ?? openDeal;
        sentOpeningThisTurn = Boolean(env.sentOpeningThisTurn);
        if (hit?.handled) return;
      }
    }

    // ── 4. Roda o LLM normalmente ─────────────────────────────
    const result = await runAgent({
      agentId: cfg.id,
      source: "inbox",
      userMessage: args.userMessage,
      conversationId: args.conversationId,
      contactId: args.contactId,
      dealId: openDeal?.id ?? null,
    });

    if (result.status === "FAILED") {
      logAi("run_failed", {
        conversationId: args.conversationId,
        error: result.error ?? "unknown",
        durationMs: Date.now() - startedAt.getTime(),
      });
      // Falha de LLM/chave NÃO é pedido de humano: um erro isolado fica na
      // IA para retry. Mas chave/cota inválida ou falha repetida derruba o
      // atendimento inteiro — aí o aluno precisa de um consultor.
      const distributeOnFailure = await shouldDistributeAfterRunFailure({
        conversationId: args.conversationId,
        error: result.error,
      });
      if (
        !distributeOnFailure ||
        !packOps.isImmediateAcademicHandoffJustified(args.userMessage, policy)
      ) {
        return;
      }

      await packOps.executeAcademicDepartmentHandoff({
        conversationId: args.conversationId,
        contactId: args.contactId,
        dealId: openDeal?.id ?? null,
        userMessage: args.userMessage,
        reason: `Falha no run da IA: ${result.error ?? "unknown"}`,
        policy,
      }).catch(() => null);
      {
        const gotHuman = await conversationAssignedToHuman(args.conversationId);
        // Durante uma queda o aluno escreve várias vezes: só avisa da fila
        // uma vez, senão repete o mesmo texto em cada mensagem.
        const lastBotOut = await prisma.message.findFirst({
          where: {
            conversationId: args.conversationId,
            direction: "out",
            authorType: "bot",
            isPrivate: false,
            messageType: { not: "note" },
          },
          orderBy: { createdAt: "desc" },
          select: { content: true },
        });
        if (!messageLooksLikeHumanQueueNotice(lastBotOut?.content)) {
          await sendAgentMessage({
            conversationId: args.conversationId,
            contactId: args.contactId,
            agentUserId: assignee.id,
            autonomyMode: cfg.autonomyMode,
            text: studentNoticeAfterHandoff(
              gotHuman,
              buildGenericQueueHandoffMessage(new Date(), policy, hours),            ),
            channel: args.channel,
            kind: "text",
            humanBehavior,
            generationId: args.generationId,
            bypassAssigneeCheck: true,
          }).catch(() => null);
        }
      }
      logAi("handoff", {
        conversationId: args.conversationId,
        reason: "run_failed",
        error: result.error ?? "unknown",
      });
      return;
    }

    const parsedEarly = parseAgentConfidence(result.text || "");
    const replyText = parsedEarly.text.trim();
    // Tool/HANDOFF OU promessa explícita no texto ("vou te conectar…") →
    // distribui de fato. Cumprimento / "me ajuda" / primeiro acesso NÃO
    // viram fila. Fora do expediente, o template de horário só sai se o
    // aluno pediu humano ou o tema exige depto (retenção, TCE, curso…).
    const selfServeTurn = isAcademicSelfServeTurn(args.userMessage, packOps);
    const justifiedHandoff = packOps.isImmediateAcademicHandoffJustified(
      args.userMessage,
      policy,
    );
    const lowConfHandoff =
      policy.lowConfidenceHandoff &&
      shouldHandoffOnLowConfidence(
        parsedEarly.confidence,
        policy.confidenceThreshold ?? undefined,
      ) &&
      !selfServeTurn;
    let transferred =
      result.status === "HANDOFF" ||
      runHadTransferTools(result.toolCalls) ||
      packOps.textImpliesAcademicHandoff(replyText) ||
      lowConfHandoff;
    if (transferred && !justifiedHandoff) {
      transferred = false;
    }

    if (transferred) {
      const handoffText =
        replyText ||
        (packOps.inferDepartmentFromContext({
          userMessage: args.userMessage,
          policy,
        }) === "retencao"
          ? buildRetentionHandoffMessage(new Date(), policy, hours)
          : buildGenericQueueHandoffMessage(new Date(), policy, hours));
      // Distribui primeiro; só depois envia UMA mensagem ao aluno.
      // Humano atribuído → saudação da automação (lead_distributed).
      const afterHandoff = await prisma.conversation.findUnique({
        where: { id: args.conversationId },
        select: {
          assignedToId: true,
          assignedTo: { select: { type: true } },
        },
      });
      const alreadyHuman = afterHandoff?.assignedTo?.type === "HUMAN";
      const alreadyQueued = await prisma.distributionPending.findFirst({
        where: {
          status: "PENDING",
          OR: [
            { conversationId: args.conversationId },
            { contactId: args.contactId },
          ],
        },
        select: { id: true },
      });
      if (alreadyHuman) {
        await packOps.moveOpenDealToEmAtendimento({
          dealId: openDeal?.id ?? null,
          contactId: args.contactId,
        }).catch(() => null);
      } else if (!alreadyQueued || afterHandoff?.assignedTo?.type === "AI") {
        await packOps.executeAcademicDepartmentHandoff({
          conversationId: args.conversationId,
          contactId: args.contactId,
          dealId: openDeal?.id ?? null,
          userMessage: args.userMessage,
          reason: lowConfHandoff
            ? `Baixa confiança da IA (${parsedEarly.confidence?.toFixed(2)})`
            : runHadTransferTools(result.toolCalls)
              ? "Handoff via tool da IA — distribuição/fila"
              : packOps.textImpliesAcademicHandoff(replyText)
                ? "IA prometeu conectar — reforço distribuição/fila"
                : "Handoff acadêmico — reforço backend",
          policy,
        }).catch(() => null);
      }
      const afterQueue = await prisma.conversation.findUnique({
        where: { id: args.conversationId },
        select: {
          assignedToId: true,
          assignedTo: { select: { type: true } },
        },
      });
      const gotHuman = afterQueue?.assignedTo?.type === "HUMAN";
      if (!gotHuman) {
        await prisma.$transaction(async (tx) => {
          await tx.conversation.update({
            where: { id: args.conversationId },
            data: { assignedToId: assignee.id },
          });
          await tx.contact.update({
            where: { id: args.contactId },
            data: { assignedToId: assignee.id },
          });
        });
      }

      const recentBot = await prisma.message.findMany({
        where: {
          conversationId: args.conversationId,
          direction: "out",
          authorType: "bot",
          isPrivate: false,
          messageType: { not: "note" },
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { content: true },
      });
      const alreadyNoticed = recentBot.some((m) =>
        messageLooksLikeHumanQueueNotice(m.content),
      );
      const llmCoversQueue =
        messageLooksLikeHumanQueueNotice(handoffText) ||
        /fila|indispon|posso continuar|a partir das\s*\d/i.test(handoffText);

      const retentionDept =
        packOps.inferDepartmentFromContext({
          userMessage: args.userMessage,
          policy,
        }) === "retencao";
      const policyQueueText = retentionDept
        ? buildRetentionHandoffMessage(new Date(), policy, hours)
        : buildGenericQueueHandoffMessage(new Date(), policy, hours);
      const llmPromisesSoon =
        /em breve|logo algu[eé]m|s[oó] um instante|já te conectar/i.test(
          handoffText,
        );

      let outbound: string | null = null;
      if (gotHuman) {
        // lead_distributed muitas vezes não chega (janela 24h fechada após
        // HSM de campanha). Sem aviso o aluno fica esperando sem saber
        // que já foi para um consultor.
        if (alreadyNoticed) {
          outbound = null;
        } else if (
          replyText.trim() &&
          messageLooksLikeHumanQueueNotice(handoffText)
        ) {
          outbound = handoffText;
        } else {
          outbound = buildAssignedConsultantNotice();
        }
      } else if (alreadyNoticed) {
        // Já avisou fila — não repete; só envia se o LLM trouxe info nova
        // e não for near-duplicate / promessa falsa de "em breve".
        if (
          replyText.trim() &&
          !llmPromisesSoon &&
          isHumanAttendanceWindowOpen(new Date(), hours) &&
          !recentBot.some(
            (m) => m.content && isNearDuplicateBotText(handoffText, m.content),
          )
        ) {
          outbound = handoffText;
        }
      } else if (
        !isHumanAttendanceWindowOpen(new Date(), hours) ||
        llmPromisesSoon ||
        !llmCoversQueue
      ) {
        // Fora do expediente, promessa de "em breve", ou LLM sem aviso de fila:
        // usa mensagem de política (horário + empatia).
        outbound = policyQueueText;
      } else {
        outbound = handoffText;
      }

      if (outbound) {
        await sendAgentMessage({
          conversationId: args.conversationId,
          contactId: args.contactId,
          agentUserId: assignee.id,
          autonomyMode: cfg.autonomyMode,
          text: outbound,
          channel: args.channel,
          kind: "text",
          humanBehavior,
          generationId: args.generationId,
          bypassAssigneeCheck: true,
        }).catch(() => null);
      }
      logAi("handoff", {
        conversationId: args.conversationId,
        reason: "tool_transfer",
        gotHuman,
        alreadyNoticed,
        durationMs: Date.now() - startedAt.getTime(),
      });
      return;
    }

    const parsed = parseAgentConfidence(result.text.trim());
    let text = rewriteMismatchedDaypartWish(parsed.text);
    if (
      messageLooksLikeHumanQueueNotice(text) &&
      !justifiedHandoff &&
      !userWantsHumanDistribution(args.userMessage)
    ) {
      text = packOps.isAvaOrDisciplinesIntent(args.userMessage)
        ? packOps.buildAvaDisciplinesMessage()
        : buildAcademicStayWithYouMessage();
    }
    // Evita eco de resposta idêntica/quase idêntica sem o aluno ter avançado.
    if (text) {
      const recentSame = await prisma.message.findFirst({
        where: {
          conversationId: args.conversationId,
          direction: "out",
          authorType: "bot",
          isPrivate: false,
          messageType: { not: "note" },
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      });
      if (
        recentSame?.content &&
        isNearDuplicateBotText(text, recentSame.content)
      ) {
        logAi("reply_near_duplicate_skipped", {
          conversationId: args.conversationId,
          durationMs: Date.now() - startedAt.getTime(),
        });
        return;
      }
    }
    // Persiste a confiança auto-declarada no run (métrica de qualidade).
    if (parsed.confidence !== null) {
      await prisma.aIAgentRun
        .update({
          where: { id: result.runId },
          data: { confidence: parsed.confidence },
        })
        .catch(() => null);
    }
    if (!text) {
      logAi("empty_reply", {
        conversationId: args.conversationId,
        durationMs: Date.now() - startedAt.getTime(),
      });
      return;
    }

    // Revalida ANTES de enviar (humano pode ter assumido durante o LLM).
    const auth = await assertAiStillAuthorized({
      conversationId: args.conversationId,
      expectedAgentUserId: assignee.id,
      generationId: args.generationId,
      since: startedAt,
    });
    if (!auth.ok) {
      // Caso clássico do bug: tool de distribuição limpou o assignee e a
      // mensagem útil do LLM morria aqui. Se ainda temos texto, envia com bypass.
      if (
        text &&
        (auth.reason === "unassigned" || auth.reason === "assignee_changed")
      ) {
        await sendAgentMessage({
          conversationId: args.conversationId,
          contactId: args.contactId,
          agentUserId: assignee.id,
          autonomyMode: cfg.autonomyMode,
          text,
          channel: args.channel,
          kind: "text",
          humanBehavior,
          generationId: args.generationId,
          bypassAssigneeCheck: true,
        }).catch(() => null);
        logAi("sent_after_unassign", {
          conversationId: args.conversationId,
          reason: auth.reason,
          durationMs: Date.now() - startedAt.getTime(),
        });
        return;
      }
      logAi("blocked", {
        conversationId: args.conversationId,
        reason: auth.reason,
        phase: "pre_send",
        durationMs: Date.now() - startedAt.getTime(),
      });
      return;
    }

    if (result.autonomyMode === "AUTONOMOUS" && args.channel === "meta") {
      if (!metaClient.configured) {
        console.warn("[ai-inbox] Meta não configurado para este canal; gravando como rascunho.");
        await saveDraft(assignee.id, args.conversationId, text);
        return;
      }
      const contact = await prisma.contact.findUnique({
        where: { id: args.contactId },
        select: { phone: true },
      });
      if (!contact?.phone) {
        await saveDraft(assignee.id, args.conversationId, text);
        return;
      }

      await applyHumanBehaviorBeforeSend({
        conversationId: args.conversationId,
        text,
        humanBehavior,
        metaClient,
      });

      // Segunda revalidação após typing delay.
      const auth2 = await assertAiStillAuthorized({
        conversationId: args.conversationId,
        expectedAgentUserId: assignee.id,
        generationId: args.generationId,
        since: startedAt,
      });
      if (!auth2.ok) {
        logAi("blocked", {
          conversationId: args.conversationId,
          reason: auth2.reason,
          phase: "pre_send_after_typing",
        });
        return;
      }

      let externalId: string | null = null;
      try {
        const send = await metaClient.sendText(contact.phone, text);
        externalId = send.messages?.[0]?.id ?? null;
      } catch (err) {
        console.error(
          `[ai-inbox] Falha ao enviar resposta autônoma: ${err}. Salvando rascunho pro humano revisar.`,
        );
        logAi("send_failed", {
          conversationId: args.conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
        await saveDraft(assignee.id, args.conversationId, text);
        return;
      }
      const saved = await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: args.conversationId,
          content: text,
          direction: "out",
          messageType: "text",
          authorType: "bot",
          aiAgentUserId: assignee.id,
          senderName: "Agente IA",
          externalId,
          sendStatus: "sent",
        }),
      });
      await prisma.conversation
        .update({
          where: { id: args.conversationId },
          data: {
            lastMessageDirection: "out",
            hasAgentReply: true,
            updatedAt: new Date(),
          },
        })
        .catch(() => null);
      sseBus.publish("new_message", {
        organizationId: getOrgIdOrNull(),
        conversationId: args.conversationId,
        contactId: args.contactId,
        direction: "out",
        content: text,
        timestamp: saved.createdAt,
      });
      logAi("send_ok", {
        conversationId: args.conversationId,
        messageId: saved.id,
        channel: "meta",
        model: cfg.model,
        durationMs: Date.now() - startedAt.getTime(),
      });
      if (result.followUpMedia?.length) {
        const mediaCount = await sendAgentFollowUpMedia({
          conversationId: args.conversationId,
          contactId: args.contactId,
          agentUserId: assignee.id,
          attachments: result.followUpMedia,
        }).catch((err) => {
          console.warn(
            "[ai-inbox] follow-up media falhou:",
            err instanceof Error ? err.message : err,
          );
          return 0;
        });
        if (mediaCount) {
          logAi("send_media_ok", {
            conversationId: args.conversationId,
            mediaCount,
          });
        }
      }
      await closeAfterFarewellIfNeeded({
        conversationId: args.conversationId,
        contactId: args.contactId,
        userMessage: args.userMessage,
        replyText: text,
        packOps,
      });
      return;
    }

    // Baileys / draft path via sendAgentMessage (com revalidação interna).
    if (result.autonomyMode === "AUTONOMOUS" && args.channel === "baileys") {
      const sendResult = await sendAgentMessage({
        conversationId: args.conversationId,
        contactId: args.contactId,
        agentUserId: assignee.id,
        autonomyMode: cfg.autonomyMode,
        text,
        channel: "baileys",
        humanBehavior,
        generationId: args.generationId,
      });
      logAi("send_result", {
        conversationId: args.conversationId,
        status: sendResult.status,
        channel: "baileys",
        durationMs: Date.now() - startedAt.getTime(),
      });
      if (sendResult.status === "sent") {
        if (result.followUpMedia?.length) {
          const mediaCount = await sendAgentFollowUpMedia({
            conversationId: args.conversationId,
            contactId: args.contactId,
            agentUserId: assignee.id,
            attachments: result.followUpMedia,
          }).catch((err) => {
            console.warn(
              "[ai-inbox] follow-up media falhou:",
              err instanceof Error ? err.message : err,
            );
            return 0;
          });
          if (mediaCount) {
            logAi("send_media_ok", {
              conversationId: args.conversationId,
              mediaCount,
            });
          }
        }
        await closeAfterFarewellIfNeeded({
          conversationId: args.conversationId,
          contactId: args.contactId,
          userMessage: args.userMessage,
          replyText: text,
          packOps,
        });
      }
      return;
    }

    await saveDraft(assignee.id, args.conversationId, text);
    logAi("draft_saved", {
      conversationId: args.conversationId,
      durationMs: Date.now() - startedAt.getTime(),
    });
  } catch (err) {
    console.error("[ai-inbox] erro não-fatal:", err);
    logAi("run_error", {
      conversationId: args.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function saveDraft(
  agentUserId: string,
  conversationId: string,
  text: string,
) {
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId,
      content: text,
      direction: "out",
      messageType: "ai_draft",
      authorType: "bot",
      isPrivate: true,
      aiAgentUserId: agentUserId,
      senderName: "Agente IA (rascunho)",
      sendStatus: "draft",
    }),
  });
  sseBus.publish("new_message", {
    organizationId: getOrgIdOrNull(),
    conversationId,
    direction: "out",
    messageType: "ai_draft",
    content: text,
    timestamp: saved.createdAt,
  });
  void createConversationEvent({
    conversationId,
    action: "ia",
    text: "Agente IA sugeriu resposta automática",
    actor: "Agente IA",
    authorType: "bot",
    dedupeStartsWith: ["Agente IA sugeriu"],
    dedupeWindowMs: 60_000,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Aplica "digitando..." e/ou "lido" (status=read) no WhatsApp do
 * cliente antes do agente responder. Falhas são engolidas: os
 * endpoints Meta têm janelas estreitas de validade (~30s) e não
 * devemos bloquear o envio da resposta real por causa disso.
 */
async function applyHumanBehaviorBeforeSend(args: {
  conversationId: string;
  text: string;
  humanBehavior: {
    simulateTyping: boolean;
    typingPerCharMs: number;
    markMessagesRead: boolean;
  };
  metaClient: MetaWhatsAppClient;
}): Promise<void> {
  const { simulateTyping, typingPerCharMs, markMessagesRead } =
    args.humanBehavior;
  if (!simulateTyping && !markMessagesRead) return;

  const inbound = await prisma.message.findFirst({
    where: {
      conversationId: args.conversationId,
      direction: "in",
      externalId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { externalId: true },
  });
  const wamid = inbound?.externalId;
  if (!wamid) return;

  if (simulateTyping) {
    // sendTypingIndicator já marca como lida no mesmo request.
    await args.metaClient.sendTypingIndicator(wamid);
    const delayMs = computeTypingDelayMs(args.text.length, typingPerCharMs);
    await delay(delayMs);
    return;
  }

  if (markMessagesRead) {
    try {
      await args.metaClient.markAsRead(wamid);
    } catch (err) {
      console.warn(
        "[ai-inbox] markAsRead falhou:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}


async function resolveInboxVerticalPack(
  conversation: { assignedToId: string | null } | null,
) {
  if (conversation?.assignedToId) {
    const u = await prisma.user.findFirst({
      where: { id: conversation.assignedToId, type: "AI" },
      select: {
        aiAgentConfig: { select: { verticalPack: true, active: true } },
      },
    });
    if (u?.aiAgentConfig?.active) {
      return getVerticalPack(u.aiAgentConfig.verticalPack);
    }
  }
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;
  const fallback = await prisma.user.findFirst({
    where: {
      organizationId: orgId,
      type: "AI",
      aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
    },
    select: { aiAgentConfig: { select: { verticalPack: true } } },
    orderBy: { createdAt: "asc" },
  });
  return getVerticalPack(fallback?.aiAgentConfig?.verticalPack);
}

function makeInboxInterceptEnv(input: {
  args: InboundAIArgs;
  conversation: any;
  logAi: typeof logAi;
  startedAt: Date;
  helpers: Record<string, any>;
  assignee?: any;
  cfg?: any;
  policy?: any;
  hours?: any;
  humanBehavior?: any;
}) {
  return {
    args: input.args,
    conversation: input.conversation,
    logAi: input.logAi,
    startedAt: input.startedAt,
    ...input.helpers,
    assignee: input.assignee,
    cfg: input.cfg,
    policy: input.policy,
    hours: input.hours,
    humanBehavior: input.humanBehavior,
    openDeal: null as { id: string } | null,
    sentOpeningThisTurn: false,
  };
}
