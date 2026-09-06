/**
 * Interceptos academic — corpos extraídos do inbox-handler (ordem preservada).
 */

import type {
  VerticalIntercept,
  VerticalInterceptCtx,
  VerticalInterceptHit,
} from "@/verticals/types";

import {
  buildAvaDisciplinesMessage,
  buildFirstAccessChoiceMessage,
  buildFirstAccessPackMessage,
  buildFirstAccessStuckMessage,
  isAvaOrDisciplinesIntent,
  isFirstAccessIntent,
  isFirstAccessStuckIntent,
  messageLooksLikeFirstAccessHelp,
  messageLooksLikeFirstAccessPack,
  parseFirstAccessChoice,
} from "@/verticals/academic/atendimento-prompt";
import {
  closeAiOnlyConversation,
  shouldCloseAfterAgentFarewell,
  shouldCloseAiAfterStudentMessage,
  userWantsAiConversationClose,
} from "@/verticals/academic/closure";
import {
  executeAcademicDepartmentHandoff,
  inferDepartmentFromContext,
  isCourseShoppingInquiry,
  isImmediateAcademicHandoffJustified,
  moveOpenDealToEmAtendimento,
  shouldHandoffCurriculumOrTce,
  textImpliesAcademicHandoff,
} from "@/verticals/academic/department-routing";
import {
  buildInauguralClassLinkMessage,
  conversationAlreadyGotInauguralLink,
  shouldSendInauguralClassLink,
} from "@/verticals/academic/inaugural-class-link";
import {
  buildAudioHandoffMessage,
  detectInboundAudio,
  messageLooksLikeAudioNotice,
} from "@/services/ai/audio-inbound";
import { evaluateAttendanceScope } from "@/services/ai/attendance-scope";
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
import {
  buildNaturalAttendanceCloseReply,
  buildSoftCloseAfterNudgeReply,
  isIdleNudgeContent,
  userWantsSoftAiClose,
} from "@/services/ai/idle-followup";
import { matchHandoffKeyword, renderTemplate } from "@/lib/ai-agents/piloting";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";

function hit(
  interceptName: string,
  meta?: Record<string, unknown>,
): VerticalInterceptHit {
  return { handled: true, interceptName, meta };
}

export const ACADEMIC_INTERCEPT_ORDER = [
  "first_access",
  "ava_disciplines",
  "greeting_self_serve",
  "attendance_scope",
  "inaugural_class_link",
  "pending_handoff",
  "handoff_ack_silence",
  "ai_only_close",
  "inbound_audio",
  "keyword_handoff",
  "course_shopping",
  "curriculum_or_tce",
  "retention_intent",
  "opening_and_greeting_only",
] as const;

export async function runAcademicInterceptPipeline(
  phase: "pre_assignee" | "post_assignee",
  ctx: VerticalInterceptCtx,
): Promise<VerticalInterceptHit | null> {
  const e = ctx.env;

  const {
    args,
    logAi,
    recordInboxInterceptRun,
    sendAgentMessage,
    isBareGreetingMessage,
    isAcademicSelfServeTurn,
    buildAcademicStayWithYouMessage,
    buildRetentionHandoffMessage,
    buildGenericQueueHandoffMessage,
    studentNoticeAfterHandoff,
    conversationAssignedToHuman,
    startedAt,
    cancelAiReplyDebounce,
    assertAiStillAuthorized,
    hasAgentGreetedInCurrentAssignment,
    markAgentGreetedNow,
    delay,
    assignee,
    cfg,
    policy,
    hours,
    humanBehavior,
  } = e;

  let conversation = e.conversation;
  let openDeal = e.openDeal;
  let sentOpeningThisTurn = e.sentOpeningThisTurn ?? false;

  if (phase === "post_assignee" && !openDeal) {
    openDeal = await prisma.deal.findFirst({
      where: { contactId: args.contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    e.openDeal = openDeal;
  }

  if (phase === "pre_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // Primeiro acesso (pedido, "não consegui", ou "1"/portal): a IA atende.
          {
            const lastBotFa = await prisma.message.findFirst({
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
            const faChoice =
              messageLooksLikeFirstAccessHelp(lastBotFa?.content)
                ? parseFirstAccessChoice(args.userMessage)
                : null;
            if (
              faChoice ||
              isFirstAccessIntent(args.userMessage) ||
              isFirstAccessStuckIntent(args.userMessage)
            ) {
              const orgId = getOrgIdOrNull();
              let aiId: string | null = null;
              if (conversation?.assignedToId) {
                const assignedAi = await prisma.user.findFirst({
                  where: { id: conversation.assignedToId, type: "AI" },
                  select: { id: true },
                });
                aiId = assignedAi?.id ?? null;
              }
              if (!aiId && orgId) {
                const fallbackAi = await prisma.user.findFirst({
                  where: {
                    organizationId: orgId,
                    type: "AI",
                    aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
                  },
                  select: { id: true },
                  orderBy: { createdAt: "asc" },
                });
                aiId = fallbackAi?.id ?? null;
              }
              if (aiId) {
                const alreadyPack = messageLooksLikeFirstAccessPack(
                  lastBotFa?.content,
                );
                const text = faChoice
                  ? buildFirstAccessChoiceMessage(faChoice)
                  : isFirstAccessStuckIntent(args.userMessage) || alreadyPack
                    ? buildFirstAccessStuckMessage()
                    : buildFirstAccessPackMessage();
                await prisma.distributionPending
                  .updateMany({
                    where: {
                      status: "PENDING",
                      OR: [
                        { conversationId: args.conversationId },
                        { contactId: args.contactId },
                      ],
                    },
                    data: { status: "CANCELLED" },
                  })
                  .catch(() => null);
                await prisma
                  .$transaction(async (tx) => {
                    await tx.conversation.update({
                      where: { id: args.conversationId },
                      data: { assignedToId: aiId },
                    });
                    await tx.contact.update({
                      where: { id: args.contactId },
                      data: { assignedToId: aiId },
                    });
                  })
                  .catch(() => null);
                await sendAgentMessage({
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  agentUserId: aiId,
                  autonomyMode: "AUTONOMOUS",
                  text,
                  channel: args.channel,
                  kind: "text",
                  bypassAssigneeCheck: true,
                }).catch(() => null);
                logAi(
                  faChoice
                    ? "first_access_choice"
                    : alreadyPack || isFirstAccessStuckIntent(args.userMessage)
                      ? "first_access_stuck_help"
                      : "first_access_pack_sent",
                  {
                    conversationId: args.conversationId,
                    contactId: args.contactId,
                    choice: faChoice,
                  },
                );
                await recordInboxInterceptRun({
                  agentUserId: aiId,
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  interceptName: faChoice
                    ? "first_access_choice"
                    : alreadyPack || isFirstAccessStuckIntent(args.userMessage)
                      ? "first_access_stuck_help"
                      : "first_access_pack",
                });
                return hit("first_access");
              }
            }
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "pre_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // Blackboard / ver disciplinas — caminho do Portal, sem fila.
          if (isAvaOrDisciplinesIntent(args.userMessage)) {
            const orgIdAva = getOrgIdOrNull();
            let avaAi: string | null = null;
            if (conversation?.assignedToId) {
              const assignedAi = await prisma.user.findFirst({
                where: { id: conversation.assignedToId, type: "AI" },
                select: { id: true },
              });
              avaAi = assignedAi?.id ?? null;
            }
            if (!avaAi && orgIdAva) {
              const fallbackAi = await prisma.user.findFirst({
                where: {
                  organizationId: orgIdAva,
                  type: "AI",
                  aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
                },
                select: { id: true },
                orderBy: { createdAt: "asc" },
              });
              avaAi = fallbackAi?.id ?? null;
            }
            if (avaAi) {
              await prisma.distributionPending
                .updateMany({
                  where: {
                    status: "PENDING",
                    OR: [
                      { conversationId: args.conversationId },
                      { contactId: args.contactId },
                    ],
                  },
                  data: { status: "CANCELLED" },
                })
                .catch(() => null);
              await prisma
                .$transaction(async (tx) => {
                  await tx.conversation.update({
                    where: { id: args.conversationId },
                    data: { assignedToId: avaAi },
                  });
                  await tx.contact.update({
                    where: { id: args.contactId },
                    data: { assignedToId: avaAi },
                  });
                })
                .catch(() => null);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: avaAi,
                autonomyMode: "AUTONOMOUS",
                text: buildAvaDisciplinesMessage(),
                channel: args.channel,
                kind: "text",
                bypassAssigneeCheck: true,
              }).catch(() => null);
              logAi("ava_disciplines_help", {
                conversationId: args.conversationId,
                contactId: args.contactId,
              });
              await recordInboxInterceptRun({
                agentUserId: avaAi,
                conversationId: args.conversationId,
                contactId: args.contactId,
                interceptName: "ava_disciplines",
              });
              return hit("ava_disciplines");
            }
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "pre_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // "oi" / "olá" / "?" — a IA cumprimenta. Nunca vira fila das 8h.
          if (
            isBareGreetingMessage(args.userMessage) ||
            /^\?+$/.test((args.userMessage ?? "").trim())
          ) {
            const orgIdG = getOrgIdOrNull();
            let greetAi: string | null = null;
            if (conversation?.assignedToId) {
              const assignedAi = await prisma.user.findFirst({
                where: { id: conversation.assignedToId, type: "AI" },
                select: { id: true },
              });
              greetAi = assignedAi?.id ?? null;
            }
            if (!greetAi && orgIdG) {
              const fallbackAi = await prisma.user.findFirst({
                where: {
                  organizationId: orgIdG,
                  type: "AI",
                  aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
                },
                select: { id: true },
                orderBy: { createdAt: "asc" },
              });
              greetAi = fallbackAi?.id ?? null;
            }
            if (greetAi) {
              await prisma.distributionPending
                .updateMany({
                  where: {
                    status: "PENDING",
                    OR: [
                      { conversationId: args.conversationId },
                      { contactId: args.contactId },
                    ],
                  },
                  data: { status: "CANCELLED" },
                })
                .catch(() => null);
              await prisma
                .$transaction(async (tx) => {
                  await tx.conversation.update({
                    where: { id: args.conversationId },
                    data: { assignedToId: greetAi },
                  });
                  await tx.contact.update({
                    where: { id: args.contactId },
                    data: { assignedToId: greetAi },
                  });
                })
                .catch(() => null);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: greetAi,
                autonomyMode: "AUTONOMOUS",
                text: buildAcademicStayWithYouMessage(),
                channel: args.channel,
                kind: "text",
                bypassAssigneeCheck: true,
              }).catch(() => null);
              logAi("greeting_self_serve", {
                conversationId: args.conversationId,
                contactId: args.contactId,
              });
              await recordInboxInterceptRun({
                agentUserId: greetAi,
                conversationId: args.conversationId,
                contactId: args.contactId,
                interceptName: "greeting_self_serve",
              });
              return hit("greeting_self_serve");
            }
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 0a. Escopo de atendimento (funil / etapa / tag do contato) ──
          // Fora do escopo o agente não fala: devolve para humano ou sai
          // calado, conforme a tela. Escopo vazio = atende tudo (legado).
          const scopeVerdict = await evaluateAttendanceScope({
            contactId: args.contactId,
            policy,
          });
          if (!scopeVerdict.inScope) {
            logAi("blocked", {
              conversationId: args.conversationId,
              reason: `out_of_scope:${scopeVerdict.reason}`,
              agentUserId: assignee.id,
              action: scopeVerdict.scope.action,
            });
            if (scopeVerdict.scope.action === "handoff") {
              await executeAcademicDepartmentHandoff({
                conversationId: args.conversationId,
                contactId: args.contactId,
                userMessage: args.userMessage,
                reason: `Fora do escopo do agente (${scopeVerdict.reason})`,
                policy,
              }).catch(() => null);
              // Humano assumiu → a saudação é da automação; o agente só fala
              // se a conversa ficou na fila.
              if (
                scopeVerdict.scope.message &&
                !(await conversationAssignedToHuman(args.conversationId))
              ) {
                const contact = await prisma.contact.findUnique({
                  where: { id: args.contactId },
                  select: { name: true },
                });
                await sendAgentMessage({
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  agentUserId: assignee.id,
                  autonomyMode: cfg.autonomyMode,
                  text: renderTemplate(scopeVerdict.scope.message, {
                    contactName: contact?.name ?? null,
                  }),
                  channel: args.channel,
                  kind: "text",
                  humanBehavior,
                  generationId: args.generationId,
                  bypassAssigneeCheck: true,
                }).catch(() => null);
              }
            }
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "attendance_scope",
            });
            return hit("attendance_scope");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── Aula inaugural (hoje/amanhã): envia YouTube sem passar pelo LLM ──
          // Prioridade: tags calouros1008_1..6 (qualquer etapa). Demais: se pedirem.
          try {
            const inaugural = await shouldSendInauguralClassLink({
              contactId: args.contactId,
              userMessage: args.userMessage,
              policy,
            });
            if (inaugural.send) {
              const already = await conversationAlreadyGotInauguralLink(
                args.conversationId,
              );
              if (!already) {
                const text = buildInauguralClassLinkMessage({
                  problem: inaugural.problem,
                  policy,
                });
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
                });
                logAi("inaugural_class_link_sent", {
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  priorityCalouros: inaugural.priorityCalouros,
                  problem: inaugural.problem,
                });
                await recordInboxInterceptRun({
                  agentId: cfg.id,
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  interceptName: "inaugural_class_link",
                });
                return hit("inaugural_class_link");
              }
              logAi("inaugural_class_link_skip_already_sent", {
                conversationId: args.conversationId,
                contactId: args.contactId,
              });
              // Já enviou o link — deixa o LLM atender o follow-up.
            }
          } catch (e) {
            console.error("[ai] inaugural class link intercept failed", e);
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 0b. Pending handoff while AI is still assignee ──────────────
          // Fila ativa: tenta humano; se aluno pedir distribuição → horário + fila;
          // senão a IA pode continuar respondendo (pending permanece).
          const pendingHandoff = await prisma.distributionPending.findFirst({
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
          if (pendingHandoff) {
            const lastBotMsg = await prisma.message.findFirst({
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
              await executeAcademicDepartmentHandoff({
                conversationId: args.conversationId,
                contactId: args.contactId,
                dealId: openDeal?.id ?? null,
                userMessage: args.userMessage,
                reason: "Aluno pediu fila/humano com pending ativo",
                policy,
              }).catch(() => null);
              const afterHumanAsk = await prisma.conversation.findUnique({
                where: { id: args.conversationId },
                select: { assignedTo: { select: { type: true } } },
              });
              if (afterHumanAsk?.assignedTo?.type === "HUMAN") {
                logAi("handoff_pending_human_assigned", {
                  conversationId: args.conversationId,
                  pendingId: pendingHandoff.id,
                });
                await recordInboxInterceptRun({
                  agentId: cfg.id,
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  interceptName: "pending_handoff_human_assigned",
                });
                return hit("pending_handoff");
              }
              if (
                !lastBotMsg?.content?.includes("expediente inicia") &&
                !lastBotMsg?.content?.includes("já está na *fila*")
              ) {
                await sendAgentMessage({
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  agentUserId: assignee.id,
                  autonomyMode: cfg.autonomyMode,
                  text: buildHumanQueueWithHoursMessage(),
                  channel: args.channel,
                  kind: "text",
                  humanBehavior,
                  generationId: args.generationId,
                  bypassAssigneeCheck: true,
                }).catch(() => null);
              }
              logAi("handoff_pending_human_requested", {
                conversationId: args.conversationId,
                pendingId: pendingHandoff.id,
              });
              await recordInboxInterceptRun({
                agentId: cfg.id,
                conversationId: args.conversationId,
                contactId: args.contactId,
                interceptName: "pending_handoff_human_requested",
              });
              return hit("pending_handoff");
            }

            // Tenta redistribuir sem tirar a IA; se cair humano, para.
            const convDept = await prisma.conversation.findUnique({
              where: { id: args.conversationId },
              select: { departmentId: true },
            });
            const { executeDistribution } = await import("@/services/distribution");
            await executeDistribution({
              dealId: openDeal?.id ?? null,
              contactId: args.contactId,
              conversationId: args.conversationId,
              triggerSource: "SYSTEM",
              departmentId: convDept?.departmentId ?? null,
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
              logAi("handoff_pending_human_assigned", {
                conversationId: args.conversationId,
                pendingId: pendingHandoff.id,
              });
              await recordInboxInterceptRun({
                agentId: cfg.id,
                conversationId: args.conversationId,
                contactId: args.contactId,
                interceptName: "pending_handoff_redistribute_human",
              });
              return hit("pending_handoff");
            }
            // Garante IA assignee se a distribuição limpou sem humano.
            if (!stillOpen?.assignedToId || stillOpen.assignedToId !== assignee.id) {
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

            logAi("handoff_pending_ai_continue", {
              conversationId: args.conversationId,
              pendingId: pendingHandoff.id,
              alreadyNoticed: messageLooksLikeHumanQueueNotice(lastBotMsg?.content),
            });
            // Fall through — IA responde (sem oferta prévia duplicada).
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 0c. Post-handoff ack silence ──────────────────────────────────
          // Ack curto após aviso de fila/humano → confirma horário e mantém fila.
          // Se o aluno pedir para a IA continuar, não silencia (segue pro LLM).
          {
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
            const HANDOFF_PHRASES = [
              "vou te conectar",
              "fala com você em breve",
              "já está na fila",
              "só mais um pouquinho",
              "atendimento humano",
              "indisponível",
              "indisponivel",
              "expediente inicia",
              "atendimento humano retoma",
              "já pedi para a equipe",
              "já registrei seu pedido",
              "já te passei para um",
              "seu pedido já está com alguém",
              "setor de",
              "Retenção",
              "Acolhimento",
            ];
            if (HANDOFF_PHRASES.some((p) => lastBotOut?.content?.includes(p))) {
              if (isAcademicSelfServeTurn(args.userMessage)) {
                // "oi" / "consegue me ajudar" depois do aviso de fila → a IA atende.
              } else {
                const norm = args.userMessage
                  .normalize("NFD")
                  .replace(/\p{M}/gu, "")
                  .trim()
                  .toLowerCase();
                const isAck =
                  /^(ok|obrigad[oa]|valeu|beleza|certo|ta|tá|tudo bem|pode deixar|aguardo|fico no aguardo|ah tudo bem)[\s!.]*$/i.test(
                    norm,
                  ) ||
                  (norm.length <= 40 &&
                    /obrigad[oa]|valeu|beleza|aguardo/.test(norm));
                const wantsHuman =
                  userWantsHumanDistribution(args.userMessage) || isAck;
                const wrappingUp = shouldCloseAiAfterStudentMessage({
                  userMessage: args.userMessage,
                }).close;
                if (wantsHuman && !wrappingUp) {
                  const curConv = await prisma.conversation.findUnique({
                    where: { id: args.conversationId },
                    select: { assignedToId: true },
                  });
                  if (curConv?.assignedToId === assignee.id) {
                    await prisma.$transaction(async (tx) => {
                      await tx.conversation.update({
                        where: { id: args.conversationId },
                        data: { assignedToId: null },
                      });
                      await tx.contact.update({
                        where: { id: args.contactId },
                        data: { assignedToId: null },
                      });
                      await tx.deal.updateMany({
                        where: { contactId: args.contactId, status: "OPEN" },
                        data: { ownerId: null },
                      });
                    });
                  }
                  await executeAcademicDepartmentHandoff({
                    conversationId: args.conversationId,
                    contactId: args.contactId,
                    dealId: openDeal?.id ?? null,
                    userMessage: args.userMessage,
                    reason: "Aluno pediu/confirmou fila humana (ack pós-transferência)",
                    policy,
                  }).catch(() => null);
                  const gotHumanAck = await conversationAssignedToHuman(
                    args.conversationId,
                  );
                  if (!messageLooksLikeHumanQueueNotice(lastBotOut?.content)) {
                    await sendAgentMessage({
                      conversationId: args.conversationId,
                      contactId: args.contactId,
                      agentUserId: assignee.id,
                      autonomyMode: cfg.autonomyMode,
                      text: studentNoticeAfterHandoff(
                        gotHumanAck,
                        buildHumanQueueWithHoursMessage(),
                      ),
                      channel: args.channel,
                      kind: "text",
                      humanBehavior,
                      generationId: args.generationId,
                      bypassAssigneeCheck: true,
                    }).catch(() => null);
                  }
                  logAi("handoff_ack_silence", {
                    conversationId: args.conversationId,
                    userMessage: args.userMessage.slice(0, 50),
                  });
                  await recordInboxInterceptRun({
                    agentId: cfg.id,
                    conversationId: args.conversationId,
                    contactId: args.contactId,
                    interceptName: "handoff_ack_silence",
                  });
                  return hit("handoff_ack_silence");
                }
              }
            }
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 1c. Encerramento pedido pelo aluno (somente atendimento IA) ──
          const lastAiOut = await prisma.message.findFirst({
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
          const afterIdleNudge = isIdleNudgeContent(lastAiOut?.content);
          const recentInbound = await prisma.message.findMany({
            where: {
              conversationId: args.conversationId,
              direction: "in",
              isPrivate: false,
            },
            orderBy: { createdAt: "desc" },
            take: 4,
            select: { content: true },
          });
          const closeDecision = shouldCloseAiAfterStudentMessage({
            userMessage: args.userMessage,
            recentInbound: recentInbound
              .map((m) => m.content ?? "")
              .filter((c) => c && c !== args.userMessage),
          });
          const wantsClose =
            closeDecision.close ||
            userWantsAiConversationClose(args.userMessage) ||
            (afterIdleNudge && userWantsSoftAiClose(args.userMessage));
          if (wantsClose) {
            const closeGate = await prisma.conversation.findUnique({
              where: { id: args.conversationId },
              select: {
                status: true,
                hasHumanReply: true,
                assignedTo: { select: { type: true } },
              },
            });
            const wrapUpClose =
              closeDecision.reason === "thanks_wrapup" ||
              closeDecision.reason === "thanks_after_defer";
            const canAiClose =
              closeGate?.status !== "RESOLVED" &&
              closeGate?.assignedTo?.type === "AI" &&
              (closeGate.hasHumanReply === false || wrapUpClose);
            if (canAiClose) {
              const closeText = afterIdleNudge
                ? buildSoftCloseAfterNudgeReply()
                : closeDecision.reason === "thanks_wrapup" ||
                    closeDecision.reason === "thanks_after_defer"
                  ? buildNaturalAttendanceCloseReply()
                  : "Combinado! Estou encerrando seu atendimento por aqui. Se precisar de algo depois, é só chamar, tá? 🙂";
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: closeText,
                channel: args.channel,
                kind: "text",
                humanBehavior,
                generationId: args.generationId,
              }).catch(() => null);
              const closed = await closeAiOnlyConversation({
                conversationId: args.conversationId,
                contactId: args.contactId,
                allowAfterHumanReply: wrapUpClose,
                reason: afterIdleNudge
                  ? "Aluno encerrou após check-in de 30 min"
                  : closeDecision.reason === "thanks_wrapup" ||
                      closeDecision.reason === "thanks_after_defer"
                    ? "Aluno agradeceu e encerrou o atendimento"
                    : "Aluno pediu encerramento (detector IA)",
              });
              if (closed.closed) {
                cancelAiReplyDebounce(args.conversationId, "ai_only_close");
                logAi("closed", {
                  conversationId: args.conversationId,
                  reason: afterIdleNudge
                    ? "idle_nudge_soft_close"
                    : closeDecision.reason || "ai_only_close",
                });
                await recordInboxInterceptRun({
                  agentId: cfg.id,
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  interceptName: afterIdleNudge
                    ? "idle_nudge_soft_close"
                    : "ai_only_close",
                });
                return hit("ai_only_close");
              }
            }
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 1d. Áudio/voz do aluno → distribuição determinística ──
          // Não há transcrição automática: o LLM só receberia "[Áudio]" e
          // improvisaria ("não consegui ouvir, pode escrever?"). A regra da
          // operação é acolher em uma frase e passar para um humano.
          const audioCheck = await detectInboundAudio({
            conversationId: args.conversationId,
            userMessage: args.userMessage,
          });
          if (audioCheck.shouldHandoff) {
            const lastBotBeforeAudio = await prisma.message.findFirst({
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
            const audioDeptKey = inferDepartmentFromContext({
              userMessage: args.userMessage,
            });
            await executeAcademicDepartmentHandoff({
              conversationId: args.conversationId,
              contactId: args.contactId,
              dealId: openDeal?.id ?? null,
              userMessage: args.userMessage,
              departmentName:
                audioDeptKey === "retencao"
                  ? "Retenção"
                  : audioDeptKey === "acolhimento"
                    ? "Acolhimento"
                    : "Atendimento",
              reason: "Aluno enviou áudio — atendimento humano obrigatório",
            });
            // Áudios em sequência não repetem a bolha de aviso.
            if (!messageLooksLikeAudioNotice(lastBotBeforeAudio?.content)) {
              const gotHuman = await conversationAssignedToHuman(args.conversationId);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: buildAudioHandoffMessage({ assignedToHuman: gotHuman }),
                channel: args.channel,
                kind: "text",
                humanBehavior,
                generationId: args.generationId,
                bypassAssigneeCheck: true,
              }).catch(() => null);
            }
            logAi("handoff", {
              conversationId: args.conversationId,
              reason: "inbound_audio",
              department: audioDeptKey,
              durationMs: Date.now() - startedAt.getTime(),
            });
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "inbound_audio",
            });
            return hit("inbound_audio");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 2. Keyword handoff ────────────────────────────────────
          const keyword = matchHandoffKeyword(
            args.userMessage,
            cfg.keywordHandoffs ?? [],
          );
          if (keyword && !isAcademicSelfServeTurn(args.userMessage)) {
            const deptKey = inferDepartmentFromContext({
              userMessage: args.userMessage,
              policy,
            });
            await executeAcademicDepartmentHandoff({
              conversationId: args.conversationId,
              contactId: args.contactId,
              dealId: openDeal?.id ?? null,
              userMessage: args.userMessage,
              policy,
              departmentName:
                deptKey === "retencao"
                  ? "Retenção"
                  : deptKey === "acolhimento"
                    ? "Acolhimento"
                    : "Atendimento",
              reason: `Palavra-chave disparou handoff: "${keyword}"`,
            });
            {
              const gotHuman = await conversationAssignedToHuman(args.conversationId);
              const keywordText =
                deptKey === "retencao"
                  ? buildRetentionHandoffMessage(new Date(), policy, hours)
                  : buildGenericQueueHandoffMessage(new Date(), policy, hours);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: studentNoticeAfterHandoff(gotHuman, keywordText),
                channel: args.channel,
                kind: "text",
                humanBehavior,
                generationId: args.generationId,
                bypassAssigneeCheck: true,
              }).catch(() => null);
            }
            logAi("handoff", {
              conversationId: args.conversationId,
              reason: "keyword",
              keyword,
              department: deptKey,
            });
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "keyword_handoff",
            });
            return hit("keyword_handoff");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 2b. Curso/valor/grade (não do curso atual) → consultor ─
          // Nunca site institucional (Cruzeiro etc.): sempre humano.
          if (
            policy.interceptCourseShopping &&
            isCourseShoppingInquiry(args.userMessage, policy)
          ) {
            await executeAcademicDepartmentHandoff({
              conversationId: args.conversationId,
              contactId: args.contactId,
              dealId: openDeal?.id ?? null,
              userMessage: args.userMessage,
              departmentName: "Atendimento",
              reason:
                "Dúvida sobre valor/grade/info de curso — handoff obrigatório (sem site)",
              policy,
            });
            {
              const gotHuman = await conversationAssignedToHuman(args.conversationId);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: studentNoticeAfterHandoff(
                  gotHuman,
                  buildGenericQueueHandoffMessage(new Date(), policy, hours),          ),
                channel: args.channel,
                kind: "text",
                humanBehavior,
                generationId: args.generationId,
                bypassAssigneeCheck: true,
              }).catch(() => null);
            }
            logAi("handoff", {
              conversationId: args.conversationId,
              reason: "course_shopping",
              durationMs: Date.now() - startedAt.getTime(),
            });
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "course_shopping",
            });
            return hit("course_shopping");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 2b2. Grade/estágio obrigatório ou TCE para assinar ──
          // Sem esperar o LLM: inventar "geralmente tem estágio" / prometer
          // assinar TCE é pior que transferir. Prazo/docs de TCE NÃO entram.
          if (shouldHandoffCurriculumOrTce(args.userMessage)) {
            await executeAcademicDepartmentHandoff({
              conversationId: args.conversationId,
              contactId: args.contactId,
              dealId: openDeal?.id ?? null,
              userMessage: args.userMessage,
              departmentName: "Atendimento",
              reason:
                "Grade/estágio obrigatório ou TCE para assinatura — handoff obrigatório",
              policy,
            });
            {
              const gotHuman = await conversationAssignedToHuman(args.conversationId);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: studentNoticeAfterHandoff(
                  gotHuman,
                  buildGenericQueueHandoffMessage(new Date(), policy, hours),
                ),
                channel: args.channel,
                kind: "text",
                humanBehavior,
                generationId: args.generationId,
                bypassAssigneeCheck: true,
              }).catch(() => null);
            }
            logAi("handoff", {
              conversationId: args.conversationId,
              reason: "curriculum_or_tce",
              durationMs: Date.now() - startedAt.getTime(),
            });
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "curriculum_or_tce",
            });
            return hit("curriculum_or_tce");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          // ── 2c. Retenção determinística (tranc/cancel/desist) ─────
          // Não depende do LLM acertar a tool: avisa o aluno e distribui.
          const retentionKey = inferDepartmentFromContext({
            userMessage: args.userMessage,
            policy,
          });
          if (policy.interceptRetention && retentionKey === "retencao") {
            await executeAcademicDepartmentHandoff({
              conversationId: args.conversationId,
              contactId: args.contactId,
              dealId: openDeal?.id ?? null,
              userMessage: args.userMessage,
              departmentName: "Retenção",
              reason: "Intenção de trancamento/cancelamento (regra determinística)",
              policy,
            });
            {
              const gotHuman = await conversationAssignedToHuman(args.conversationId);
              await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: studentNoticeAfterHandoff(
                  gotHuman,
                  buildRetentionHandoffMessage(new Date(), policy, hours),          ),
                channel: args.channel,
                kind: "text",
                humanBehavior,
                generationId: args.generationId,
                bypassAssigneeCheck: true,
              }).catch(() => null);
            }
            logAi("handoff", {
              conversationId: args.conversationId,
              reason: "retention_intent",
              durationMs: Date.now() - startedAt.getTime(),
            });
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "retention_intent",
            });
            return hit("retention_intent");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  if (phase === "post_assignee") {
    const __hit = await (async (): Promise<VerticalInterceptHit | null> => {
          const priorConversations = await prisma.conversation.count({
            where: {
              contactId: args.contactId,
              NOT: { id: args.conversationId },
            },
          });
          const isReturningContact = priorConversations > 0;

          if (cfg.openingMessage?.trim() && !isReturningContact) {
            const alreadyGreeted = await hasAgentGreetedInCurrentAssignment(
              args.conversationId,
            );
            if (!alreadyGreeted) {
              const [contact, deal] = await Promise.all([
                prisma.contact.findUnique({
                  where: { id: args.contactId },
                  select: { name: true },
                }),
                openDeal
                  ? prisma.deal.findUnique({
                      where: { id: openDeal.id },
                      select: {
                        title: true,
                        stage: { select: { name: true } },
                      },
                    })
                  : Promise.resolve(null),
              ]);
              const greeting = renderTemplate(cfg.openingMessage, {
                contactName: contact?.name ?? null,
                dealTitle: deal?.title ?? null,
                stageName: deal?.stage?.name ?? null,
              });
              if (cfg.openingDelayMs > 0) {
                await delay(Math.min(cfg.openingDelayMs, 10_000));
              }
              const authGreet = await assertAiStillAuthorized({
                conversationId: args.conversationId,
                expectedAgentUserId: assignee.id,
                generationId: args.generationId,
                since: startedAt,
              });
              if (!authGreet.ok) {
                logAi("blocked", {
                  conversationId: args.conversationId,
                  reason: authGreet.reason,
                  phase: "pre_greeting_send",
                });
                return hit("opening_and_greeting_only");
              }
              const greetResult = await sendAgentMessage({
                conversationId: args.conversationId,
                contactId: args.contactId,
                agentUserId: assignee.id,
                autonomyMode: cfg.autonomyMode,
                text: greeting,
                channel: args.channel,
                kind: "greeting",
                humanBehavior,
                generationId: args.generationId,
              }).catch(() => null);
              if (greetResult && greetResult.status !== "skipped") {
                await markAgentGreetedNow(args.conversationId);
                sentOpeningThisTurn = true;
              }
            }
          }

          // Só cumprimento + já saudamos nesta rodada → não chama LLM de novo.
          if (sentOpeningThisTurn && isBareGreetingMessage(args.userMessage)) {
            logAi("greeting_only", {
              conversationId: args.conversationId,
              durationMs: Date.now() - startedAt.getTime(),
            });
            await recordInboxInterceptRun({
              agentId: cfg.id,
              conversationId: args.conversationId,
              contactId: args.contactId,
              interceptName: "greeting_only",
            });
            return hit("opening_and_greeting_only");
          }
      return null;
    })();
    if (__hit) {
      e.conversation = conversation;
      e.openDeal = openDeal;
      e.sentOpeningThisTurn = sentOpeningThisTurn;
      return __hit;
    }
  }

  e.conversation = conversation;
  e.openDeal = openDeal;
  e.sentOpeningThisTurn = sentOpeningThisTurn;
  return null;
}

export const academicIntercepts: VerticalIntercept[] = [
  {
    name: "academic_pre_assignee",
    phase: "pre_assignee",
    run: (ctx) => runAcademicInterceptPipeline("pre_assignee", ctx),
  },
  {
    name: "academic_post_assignee",
    phase: "post_assignee",
    run: (ctx) => runAcademicInterceptPipeline("post_assignee", ctx),
  },
];
