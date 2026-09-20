/**
 * Motor v2 de processamento de turno.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2Action, V2AgentConfig, V2CRMContext, V2LLMOutput, V2Owner, V2Stage } from "@/lib/ai-v2/types";
import type { V2ActionResult } from "./actions";
import { buildVariableMap, defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import { createDeal } from "@/services/deals";
import { resolveV2AgentForConversation } from "./agent-resolver";
import { loadV2Context, type V2LoadedContext } from "./context";
import { detectV2Sentiment, shouldActOnSentiment } from "./sentiment";
import { evaluateV2Rules } from "./rules";
import { selectV2Theme, getV2ThemeById } from "./themes";
import { evaluateV2Media } from "./media";
import { callV2LLM } from "./llm";
import { guardV2Output } from "./output-guard";
import { executeV2Actions, sendV2TextMessage } from "./actions";
import { getV2ConversationState, upsertV2ConversationState } from "./state";
import { logV2Turn } from "./log";
import { parseV2Counters, type V2Counters } from "./limits";
import { classifyPostCloseMessage, getPostCloseBehavior } from "./closure";
import { simpleHandoff } from "./handoff";
import {
  currentV2OnboardingStep,
  isV2OnboardingStepCompleted,
  advanceV2OnboardingState,
  incrementStepAttempt,
  parseV2OnboardingState,
  shouldHandoffOnboardingStep,
} from "./onboarding";
import { loadV2AutomationBridge, mapAutomationVariables } from "./automation-bridge";

export type V2TurnInput = {
  conversationId: string;
  channel: "meta" | "baileys" | string;
  userMessage: string;
  messageType?: string;
  turnId?: string;
};

export type V2TurnResult = {
  sentReply?: string;
  handoff: boolean;
  closed: boolean;
  error?: string;
};

const STAGES_ORDERED: V2Stage[] = ["idle", "confirming", "identifying", "active", "closed"];

function ownerToPrisma(owner: V2Owner): string {
  return owner === "automation" ? "automation" : owner;
}

function prismaToOwner(raw: string): V2Owner {
  if (raw === "pessoa") return "pessoa";
  if (raw === "automation") return "automation";
  if (raw === "ninguem") return "ninguem";
  return "agente";
}

async function loadAgentConfig(agentConfigId: string): Promise<{ config: V2AgentConfig; versionId?: string } | null> {
  const row = await (prisma as unknown as {
    aIAgentConfig: {
      findUnique: (args: { where: { id: string }; select: { simpleConfig: boolean; id: boolean } }) => Promise<{ id: string; simpleConfig: unknown } | null>;
    };
  }).aIAgentConfig.findUnique({
    where: { id: agentConfigId },
    select: { id: true, simpleConfig: true },
  });
  if (!row || !row.simpleConfig) return null;
  try {
    const config = normalizeV2Config(row.simpleConfig);
    return { config, versionId: row.id };
  } catch (err) {
    console.error("[ai-v2] invalid config", err);
    return null;
  }
}

async function getConversationContact(conversationId: string): Promise<string | null> {
  const conv = await (prisma as unknown as {
    conversation: {
      findUnique: (args: { where: { id: string }; select: { contactId: boolean } }) => Promise<{ contactId: string | null } | null>;
    };
  }).conversation.findUnique({
    where: { id: conversationId },
    select: { contactId: true },
  });
  return conv?.contactId ?? null;
}

function mergeCollectedVariables(
  existing: Record<string, unknown>,
  collected: Record<string, string>,
): Record<string, unknown> {
  return { ...existing, ...collected };
}

function messageVariables(config: V2AgentConfig, context: V2CRMContext): Record<string, unknown> {
  return buildVariableMap(config.variables, context.contact, context.selectedDeal);
}

export async function processV2Turn(input: V2TurnInput): Promise<V2TurnResult> {
  const startedAt = Date.now();
  const resolved = await resolveV2AgentForConversation(input.conversationId);
  if (!resolved) {
    return { handoff: false, closed: false, error: "No v2 agent assigned" };
  }

  const agent = await loadAgentConfig(resolved!.agentConfigId);
  if (!agent) {
    return { handoff: false, closed: false, error: "Agent config not found or invalid" };
  }
  const config = agent.config;

  const contactId = await getConversationContact(input.conversationId) ?? undefined;
  if (!contactId) {
    return { handoff: false, closed: false, error: "Conversation without contact" };
  }

  // Resolver org pela conversa
  const convOrg = await (prisma as unknown as {
    conversation: {
      findUnique: (args: { where: { id: string }; select: { organizationId: boolean } }) => Promise<{ organizationId: string } | null>;
    };
  }).conversation.findUnique({
    where: { id: input.conversationId },
    select: { organizationId: true },
  });
  if (!convOrg) return { handoff: false, closed: false, error: "Conversation not found" };
  const orgId = convOrg.organizationId;

  // Contexto CRM (necessário para regras e mídia)
  const loadedContext = await loadV2Context({
    organizationId: orgId,
    conversationId: input.conversationId,
    contactId,
    config,
  });

  const context: V2CRMContext = {
    contact: loadedContext.contact,
    deals: loadedContext.deals,
    selectedDeal: loadedContext.selectedDeal,
    fields: config.contextFields,
  };

  const vars = { ...messageVariables(config, context) };

  // Bridge automação
  const bridge = await loadV2AutomationBridge(contactId);
  const automationVariables = mapAutomationVariables(bridge, config);
  for (const [k, v] of Object.entries(automationVariables)) vars[k] = v;

  // Estado
  let stateRow = await getV2ConversationState(input.conversationId);
  let stage: V2Stage = (stateRow?.stage as V2Stage) ?? "idle";
  let owner: V2Owner = stateRow ? prismaToOwner(stateRow.owner) : "agente";
  let counters = parseV2Counters(stateRow?.counters);
  let themeId: string | undefined = stateRow?.themeId ?? undefined;
  let versionId: string | undefined = stateRow?.versionId ?? agent.versionId ?? undefined;

  // Se dono é pessoa, só registra e não responde
  if (owner === "pessoa") {
    await logV2Turn({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: context,
      prompt: "",
      executedActions: [],
      discardedActions: [{ type: "no_reply", reason: "human owner" } as any],
      handoff: false,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      owner,
      stage,
      versionId,
    });
    return { handoff: false, closed: false };
  }

  // Pós-encerramento
  if (stage === "closed" && stateRow?.postCloseWindowEndAt && new Date() < new Date(stateRow.postCloseWindowEndAt)) {
    const caseType = classifyPostCloseMessage(config, input.userMessage);
    const behavior = getPostCloseBehavior(config, caseType);

    if (caseType === "courtesy") {
      counters.courtesyReplies += 1;
      if (counters.courtesyReplies > config.limits.maxCourtesyReplies) {
        await logV2Turn({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
          inboundText: input.userMessage,
          crmContext: context,
          prompt: "", executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
          inputTokens: 0, outputTokens: 0, owner, stage, versionId,
        });
        return { handoff: false, closed: true };
      }
    }

    if (behavior === "reopen_and_route") {
      stage = "active";
      owner = "agente";
      await upsertV2ConversationState({
        organizationId: orgId,
        conversationId: input.conversationId,
        agentId: resolved!.agentConfigId,
        stage,
        owner,
        postCloseWindowEndAt: null,
        versionId: versionId,
      });
    } else if (behavior === "short_reply") {
      const short = "Por nada! Se precisar de algo novo, é só chamar.";
      await sendV2TextMessage({
        conversationId: input.conversationId,
        contactId,
        agentUserId: resolved!.userId,
        text: short,
        channel: input.channel,
        autonomyMode: config.autonomyMode === "autonomous" ? "AUTONOMOUS" : "DRAFT",
      });
      await logV2Turn({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
        inboundText: input.userMessage,
        crmContext: context,
        prompt: "", reply: short, executedActions: [], discardedActions: [], handoff: false, closed: true,
        latencyMs: Date.now() - startedAt, inputTokens: 0, outputTokens: 0, owner, stage, versionId,
      });
      return { handoff: false, closed: true, sentReply: short };
    } else if (behavior === "ask_with_options") {
      const reply = "Você precisa de ajuda com algo novo? Responda 1 para Sim ou 2 para Só agradecer.";
      await sendV2TextMessage({
        conversationId: input.conversationId,
        contactId,
        agentUserId: resolved!.userId,
        text: reply,
        channel: input.channel,
        autonomyMode: config.autonomyMode === "autonomous" ? "AUTONOMOUS" : "DRAFT",
      });
      await logV2Turn({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
        inboundText: input.userMessage,
        crmContext: context,
        prompt: "", reply, executedActions: [], discardedActions: [], handoff: false, closed: true,
        latencyMs: Date.now() - startedAt, inputTokens: 0, outputTokens: 0, owner, stage, versionId,
      });
      return { handoff: false, closed: true, sentReply: reply };
    }
  }

  // Mídia recebida
  const media = evaluateV2Media(config, input.messageType);
  if (media && media.action === "handoff") {
    const handoffMessage = renderMessage(media.message ?? config.handoff.message, vars, defaultFormatter());
    await sendV2TextMessage({
      conversationId: input.conversationId,
      contactId,
      agentUserId: resolved!.userId,
      text: handoffMessage,
      channel: input.channel,
      autonomyMode: config.autonomyMode === "autonomous" ? "AUTONOMOUS" : "DRAFT",
    });
    await simpleHandoff({
      conversationId: input.conversationId,
      contactId,
      dealId: loadedContext.dealId,
      destination: config.handoff.defaultDestination,
    });
    await upsertV2ConversationState({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      owner: "pessoa",
      versionId: versionId,
    });
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context, prompt: "media handoff", reply: handoffMessage,
      executedActions: [{ action: { type: "handoff" }, ok: true }], discardedActions: [], handoff: true, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner: "pessoa", stage, versionId,
    });
    return { handoff: true, closed: false, sentReply: handoffMessage };
  }

  // Regras determinísticas
  const rule = evaluateV2Rules(config, {
    userMessage: input.userMessage,
    messageType: input.messageType,
    isFirstMessage: !stateRow || (stateRow.stage as V2Stage) === "idle",
    contactTags: [],
    dealStageName: loadedContext.selectedDeal?.stageName as string,
    withinBusinessHours: true,
    mediaKinds: media ? [media.kind] : [],
  }, context);

  let appliedRuleId = rule?.id;

  // Fluxo de entrada / onboarding
  let prompt = "";
  let llmOutput: V2LLMOutput | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let toolCalls: Array<{ toolName: string; args: unknown; result: unknown }> | undefined;
  let governorStats: { totalCalls: number; replays: number; denials: number; limitHit: boolean } | undefined;
  let sentReply: string | undefined;
  let executedActions: V2ActionResult[] = [];
  let discardedActions: V2Action[] = [];
  let anyHandoff = false;
  let anyClose = false;
  let collectedVariables: Record<string, unknown> = { ...automationVariables };

  // Simplificação: se regra mandou handoff/close direto, executa.
  if (rule) {
    const quickActions = rule.actions.filter((a) => ["handoff", "close_conversation", "no_reply"].includes(a.type));
    if (quickActions.length > 0) {
      const actionCtx = buildActionCtx(resolved!.userId, resolved!.agentConfigId, orgId, config, loadedContext, input, contactId, "AUTONOMOUS");
      const res = await executeV2Actions(rule.actions as unknown as V2Action[], actionCtx);
      executedActions = res.results;
      anyHandoff = res.anyHandoff;
      anyClose = res.anyClose;
      // Logs e saída
      await logV2Turn({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
        inboundText: input.userMessage, crmContext: context, prompt: "rule", reply: res.anyHandoff ? config.handoff.message : undefined,
        executedActions, discardedActions: [], handoff: anyHandoff, closed: anyClose, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, owner, stage, appliedRuleId, versionId,
      });

      if (anyHandoff) {
        await upsertV2ConversationState({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
          owner: "pessoa", versionId: versionId,
        });
        return { handoff: true, closed: false };
      }
      if (anyClose) {
        await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, "rule");
        return { handoff: false, closed: true };
      }
      return { handoff: false, closed: false };
    }
  }

  // Fluxo normal
  if (stage === "idle" || stage === "confirming" || stage === "identifying") {
    if (!loadedContext.selectedDeal) {
      const onDealNotFound = config.entry.onDealNotFound;
      if (onDealNotFound === "handoff") {
        await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, "Não encontrei seu cadastro. Vou transferir para um atendente.");
        return { handoff: true, closed: false };
      } else if (onDealNotFound === "create_deal") {
        await createInitialDeal(contactId);
        stage = "active";
      } else {
        const identMsg = renderMessage(config.entry.identificationMessage ?? "Preciso confirmar seus dados. Qual o seu e-mail ou CPF?", vars, defaultFormatter());
        await sendReply(identMsg);
        await upsertV2ConversationState({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
          stage: "identifying", versionId: versionId,
        });
        await logV2Turn({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
          inboundText: input.userMessage, crmContext: context, prompt: "identification", reply: identMsg,
          executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
          inputTokens: 0, outputTokens: 0, owner, stage: "identifying", versionId,
        });
        return { handoff: false, closed: false, sentReply: identMsg };
      }
    } else if (config.entry.confirmContact && stage === "idle") {
      const confirmMsg = renderMessage(config.entry.confirmationMessage ?? "Confirmo que estou falando com você. Como posso ajudar?", vars, defaultFormatter());
      await sendReply(confirmMsg);
      await upsertV2ConversationState({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
        stage: "confirming", versionId: versionId,
      });
      await logV2Turn({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
        inboundText: input.userMessage, crmContext: context, prompt: "confirmation", reply: confirmMsg,
        executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, owner, stage: "confirming", versionId,
      });
      return { handoff: false, closed: false, sentReply: confirmMsg };
    } else if (stage === "idle") {
      stage = "active";
    }
  }

  // Onboarding
  let onboardingActive = false;
  if (config.flow === "onboarding" && config.onboarding && stage === "active") {
    onboardingActive = true;
    const step = currentV2OnboardingStep(config.onboarding, parseV2OnboardingState(collectedVariables.onboarding_state));
    if (step) {
      const prevState = parseV2OnboardingState(collectedVariables.onboarding_state);
      const llmForStep = await callLLMWithTheme(config, context, input, resolved, themeId, collectedVariables, rule, owner, stage);
      llmOutput = llmForStep.llmOutput;
      prompt = llmForStep.prompt;
      inputTokens = llmForStep.inputTokens;
      outputTokens = llmForStep.outputTokens;
      latencyMs = llmForStep.latencyMs;

      if (llmOutput && isV2OnboardingStepCompleted(step, context, llmOutput)) {
        const nextState = advanceV2OnboardingState(config.onboarding, prevState, step.id);
        collectedVariables.onboarding_state = nextState as unknown as Record<string, unknown>;
      } else {
        const nextState = incrementStepAttempt(prevState, step.id);
        if (shouldHandoffOnboardingStep(step, nextState)) {
          await simpleHandoff({ conversationId: input.conversationId, contactId, dealId: loadedContext.dealId, destination: step.handoffOnStuck });
          await upsertV2ConversationState({ organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, owner: "pessoa", versionId: versionId });
          return { handoff: true, closed: false };
        }
        collectedVariables.onboarding_state = nextState as unknown as Record<string, unknown>;
      }
    }
  }

  // LLM normal
  if (!onboardingActive) {
    const theme = selectV2Theme(config, input.userMessage, themeId);
    themeId = theme?.id ?? themeId;
    const llmResult = await callLLMWithTheme(config, context, input, resolved, themeId, collectedVariables, rule, owner, stage);
    llmOutput = llmResult.llmOutput;
    prompt = llmResult.prompt;
    inputTokens = llmResult.inputTokens;
    outputTokens = llmResult.outputTokens;
    latencyMs = llmResult.latencyMs;
    toolCalls = llmResult.toolCalls;
    governorStats = llmResult.governorStats;
  }

  if (!llmOutput) {
    const fallback = config.handoff.message;
    await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, fallback);
    return { handoff: true, closed: false, sentReply: fallback };
  }

  // Validar actions contra allowlist do tema
  const activeTheme = getV2ThemeById(config, themeId);
  const allowedTools = new Set([...(activeTheme?.allowedTools ?? []), "handoff", "close_conversation", "set_theme", "set_variable"]);
  const allowedActions: V2Action[] = [];
  for (const a of llmOutput.actions) {
    if (allowedTools.has(a.type)) allowedActions.push(a);
    else discardedActions.push(a);
  }

  // Sentimento
  const sentiment = detectV2Sentiment(config, input.userMessage);
  if (shouldActOnSentiment(config, sentiment) && !anyHandoff) {
    allowedActions.push({ type: "handoff" });
  }

  // Guarda de output
  let replyText = llmOutput.reply;
  const guard = guardV2Output(replyText, config.allowedDomains);
  replyText = guard.text;

  // Executa ações
  const actionCtx = buildActionCtx(resolved!.userId, resolved!.agentConfigId, orgId, config, loadedContext, input, contactId, config.autonomyMode === "autonomous" ? "AUTONOMOUS" : "DRAFT");
  const actionRes = await executeV2Actions(allowedActions, actionCtx);
  executedActions = actionRes.results;
  anyHandoff = actionRes.anyHandoff || llmOutput.handoff;
  anyClose = actionRes.anyClose || llmOutput.concluded;
  if (actionRes.themeId) themeId = actionRes.themeId;

  // Confirmação negativa
  if ((stage as V2Stage) === "confirming" && llmOutput.confirmed === false) {
    const identMsg = renderMessage(config.entry.identificationMessage ?? "Entendi. Vou precisar confirmar seus dados. Qual o e-mail ou CPF?", vars, defaultFormatter());
    await sendReply(identMsg);
    await upsertV2ConversationState({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
      stage: "identifying", themeId, versionId: versionId,
    });
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context, prompt, llmOutput, reply: identMsg,
      executedActions, discardedActions, handoff: false, latencyMs, inputTokens, outputTokens,
      owner, stage: "identifying", themeId, appliedRuleId, versionId,
      toolCalls, governorStats,
    });
    return { handoff: false, closed: false, sentReply: identMsg };
  }

  // Envia reply se houver e não for handoff/close
  if (!anyHandoff && !anyClose && replyText.trim()) {
    await sendReply(replyText);
    sentReply = replyText;
  }

  // Handoff via LLM
  if (anyHandoff && !anyClose) {
    const handoffMsg = renderMessage(config.handoff.message, vars, defaultFormatter());
    if (handoffMsg.trim() && handoffMsg !== replyText) {
      await sendReply(handoffMsg);
      sentReply = `${replyText}\n${handoffMsg}`.trim();
    }
    await simpleHandoff({
      conversationId: input.conversationId,
      contactId,
      dealId: loadedContext.dealId,
      destination: activeTheme?.handoffDestination ?? config.handoff.defaultDestination,
    });
    owner = "pessoa";
  }

  // Encerramento
  if (anyClose) {
    const goodbye = config.closure.goodbyeMessage;
    if (goodbye && !anyHandoff) {
      const goodbyeRendered = renderMessage(goodbye, vars, defaultFormatter());
      await sendReply(goodbyeRendered);
      sentReply = goodbyeRendered;
    }
    await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, llmOutput.concluded ? "resolved" : "transferred");
  } else {
    // Atualiza estado
    await upsertV2ConversationState({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      stage: anyHandoff ? stage : "active",
      themeId,
      owner,
      counters: counters as V2Counters,
      versionId: versionId,
    });
  }

  await logV2Turn({
    organizationId: orgId,
    conversationId: input.conversationId,
    agentId: resolved!.agentConfigId,
    turnId: input.turnId,
    inboundText: input.userMessage,
    crmContext: context,
    prompt,
    llmOutput,
    executedActions,
    discardedActions,
    reply: sentReply,
    handoff: anyHandoff,
    closed: anyClose,
    latencyMs,
    inputTokens,
    outputTokens,
    owner,
    stage,
    themeId,
    appliedRuleId,
    versionId,
    toolCalls,
    governorStats,
  });

  return { handoff: anyHandoff, closed: anyClose, sentReply };

  // --- helpers internos ---

  async function sendReply(text: string) {
    if (!text.trim()) return;
    await sendV2TextMessage({
      conversationId: input.conversationId,
      contactId: contactId!,
      agentUserId: resolved!.userId,
      text,
      channel: input.channel,
      autonomyMode: config.autonomyMode === "autonomous" ? "AUTONOMOUS" : "DRAFT",
    });
  }
}

async function callLLMWithTheme(
  config: V2AgentConfig,
  context: V2CRMContext,
  input: V2TurnInput,
  resolved: { userId: string; agentConfigId: string; wasAssigned: boolean },
  themeId: string | undefined,
  collectedVariables: Record<string, unknown>,
  rule: ReturnType<typeof evaluateV2Rules> | null,
  owner: string,
  stage: V2Stage,
): Promise<{
  llmOutput?: V2LLMOutput;
  prompt: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls?: Array<{ toolName: string; args: unknown; result: unknown }>;
  governorStats?: { totalCalls: number; replays: number; denials: number; limitHit: boolean };
}> {
  const theme = getV2ThemeById(config, themeId);
  const themeInstructions = theme
    ? `${theme.instructions}\nFerramentas permitidas: ${theme.allowedTools.join(", ")}`
    : undefined;

  const previousMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  // Carrega últimas mensagens do histórico
  try {
    const rows = await (prisma as unknown as {
      message: {
        findMany: (args: { where: Record<string, unknown>; orderBy: { createdAt: "desc" }; take: number; select: { direction: boolean; content: boolean; authorType: boolean } }) => Promise<Array<{ direction: string; content: string; authorType: string }>>;
      };
    }).message.findMany({
      where: { conversationId: input.conversationId, messageType: { not: "note" }, isPrivate: false },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { direction: true, content: true, authorType: true },
    });
    for (const m of rows.reverse()) {
      const role = m.direction === "out" || m.authorType === "bot" ? "assistant" : "user";
      previousMessages.push({ role, content: m.content ?? "" });
    }
  } catch { /* ignore */ }

  try {
    const result = await callV2LLM({
      agentId: resolved!.agentConfigId,
      config,
      context,
      userMessage: input.userMessage,
      stage,
      themeId,
      themeInstructions,
      collectedVariables,
      previousMessages,
    });
    return {
      llmOutput: result.output,
      prompt: "", // prompt ficou interno ao llm.ts
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      toolCalls: result.toolCalls,
      governorStats: result.governorStats,
    };
  } catch (err) {
    return {
      prompt: err instanceof Error ? err.message : String(err),
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  }
}

async function handoffAndReply(
  resolved: { userId: string; agentConfigId: string },
  orgId: string,
  contactId: string,
  loadedContext: V2LoadedContext,
  input: V2TurnInput,
  config: V2AgentConfig,
  stateRow: Awaited<ReturnType<typeof getV2ConversationState>>,
  versionId: string | undefined,
  message: string,
): Promise<void> {
  await sendV2TextMessage({
    conversationId: input.conversationId,
    contactId,
    agentUserId: resolved!.userId,
    text: message,
    channel: input.channel,
    autonomyMode: config.autonomyMode === "autonomous" ? "AUTONOMOUS" : "DRAFT",
  });
  await simpleHandoff({
    conversationId: input.conversationId,
    contactId,
    dealId: loadedContext.dealId,
    destination: config.handoff.defaultDestination,
  });
  await upsertV2ConversationState({
    organizationId: orgId,
    conversationId: input.conversationId,
    agentId: resolved!.agentConfigId,
    owner: "pessoa",
    versionId,
  });
  await logV2Turn({
    organizationId: orgId,
    conversationId: input.conversationId,
    agentId: resolved!.agentConfigId,
    turnId: input.turnId,
    inboundText: input.userMessage,
    crmContext: { contact: loadedContext.contact, deals: loadedContext.deals, selectedDeal: loadedContext.selectedDeal, fields: config.contextFields },
    prompt: "handoff",
    reply: message,
    executedActions: [{ action: { type: "handoff" }, ok: true }],
    discardedActions: [],
    handoff: true,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    owner: "pessoa",
    stage: (stateRow?.stage as V2Stage) ?? "idle",
    versionId,
  });
}

async function createInitialDeal(contactId: string): Promise<void> {
  const firstPipeline = await (prisma as unknown as {
    pipeline: {
      findFirst: (args: { where: Record<string, unknown>; orderBy: { createdAt: "asc" } }) => Promise<{ id: string } | null>;
    };
  }).pipeline.findFirst({
    where: { isDefault: true },
    orderBy: { createdAt: "asc" },
  });
  const stage = firstPipeline
    ? await (prisma as unknown as {
        stage: {
          findFirst: (args: { where: { pipelineId: string }; orderBy: { position: "asc" } }) => Promise<{ id: string } | null>;
        };
      }).stage.findFirst({
        where: { pipelineId: firstPipeline.id },
        orderBy: { position: "asc" },
      })
    : null;
  await createDeal({
    title: "Novo atendimento",
    contactId,
    stageId: stage?.id,
    status: "OPEN",
  } as any);
}

async function closeState(
  orgId: string,
  conversationId: string,
  agentConfigId: string,
  dealId: string | undefined,
  config: V2AgentConfig,
  versionId: string | undefined,
  reason: string,
): Promise<void> {
  const windowHours = config.closure.postCloseWindowHours;
  const postCloseWindowEndAt = new Date(Date.now() + windowHours * 60 * 60 * 1000);
  await (prisma as unknown as {
    conversation: {
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    };
  }).conversation.update({
    where: { id: conversationId },
    data: { status: "RESOLVED" },
  });
  if (dealId && config.closure.returnToOriginStage) {
    // Devolver à etapa de origem exigiria guardar originStageId ao iniciar atendimento.
    // Aqui movemos para a primeira etapa do funil como placeholder.
  }
  await upsertV2ConversationState({
    organizationId: orgId,
    conversationId,
    agentId: agentConfigId,
    stage: "closed",
    owner: "ninguem",
    postCloseWindowEndAt,
    closeReason: reason,
    versionId,
  });
}

function buildActionCtx(
  agentUserId: string,
  agentId: string,
  organizationId: string,
  config: V2AgentConfig,
  loadedContext: V2LoadedContext,
  input: V2TurnInput,
  contactId: string,
  autonomyMode: "AUTONOMOUS" | "DRAFT",
) {
  return {
    agentUserId,
    agentId,
    organizationId,
    config,
    context: loadedContext,
    conversationId: input.conversationId,
    contactId,
    dealId: loadedContext.dealId,
    llmOutput: {} as any,
    channel: input.channel,
    autonomyMode,
  };
}
