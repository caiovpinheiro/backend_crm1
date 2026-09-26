/**
 * Motor v2 de processamento de turno.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2Action, V2AgentConfig, V2CRMContext, V2Destination, V2LLMOutput, V2Owner, V2Stage } from "@/lib/ai-v2/types";
import type { V2ActionResult } from "./actions";
import { applyConfirmationIdentity, buildVariableMap, confirmationIdentityValues, defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import { createDeal } from "@/services/deals";
import { resolveV2AgentForConversation } from "./agent-resolver";
import { loadV2Context, buildAskDealMessage, tryParseDealChoice, type V2LoadedContext } from "./context";
import { detectV2Sentiment, shouldActOnSentiment } from "./sentiment";
import { evaluateV2Rules, isWithinV2BusinessHours } from "./rules";
import { getV2ThemeById } from "./themes";
import { selectV2ThemeSemantic, type V2ThemeSelection } from "./theme-semantic";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { evaluateV2Media } from "./media";
import { enrichTurnWithMedia } from "./media-turn";
import { isMediaPlaceholderText } from "@/lib/ai-agents/media-placeholder";
import { getMediaTexts, mediaTextLine, understoodKindOf } from "./media-understanding";
import { callV2LLM } from "./llm";
import { themePromptText } from "./theme-prompt";
import { actionValueAllowed, allowedActionTypes, allowedMessageModelIdsFor, mentionsHumanRequest, normalizeAskOptions } from "./action-policy";

export { mentionsHumanRequest };
import { guardV2Output } from "./output-guard";
import { executeV2Actions, sendV2TextMessage, applyV2ClosureFieldUpdates, v2HumanBehavior } from "./actions";
import { findInheritablePostCloseState, getV2ConversationState, upsertV2ConversationState } from "./state";
import { logV2Turn } from "./log";
import { noteV2Fact, peekV2Fact, runWithV2Trace, traceStep, v2TraceWasLogged } from "./trace";
import { evaluateV2StopLimits, parseV2Counters, type V2Counters } from "./limits";
import { classifyPostCloseMessage, getPostCloseBehavior, keepOpenOnNewRequest } from "./closure";
import { applyReplyEnding, effectiveReplyEnding, replyEndingButtons } from "./reply-ending";
import { repeatFallback } from "./ground-reply";
import { ALREADY_SENT_REPLY, MESSAGE_MODEL_REPEATED, recentlySentMessageModels } from "./sent-materials";
import { buildV2Interactive, matchPendingOption, type V2InteractivePayload } from "./interactive";
import { simpleHandoff } from "./handoff";
import {
  currentV2OnboardingStep,
  isV2OnboardingStepCompleted,
  advanceV2OnboardingState,
  incrementStepAttempt,
  parseV2OnboardingState,
  shouldHandoffOnboardingStep,
} from "./onboarding";
import { loadV2AutomationBridge, mapAutomationVariables, continueV2AutomationOnClose } from "./automation-bridge";
import {
  normalizePhoneDigits,
  phoneMatchesAllowlist,
} from "@/services/ai/phone-allowlist";
import { isAiAttendanceEnabled } from "@/services/ai/attendance-gate";
import { ensureV2AgentSchema } from "./ensure-schema";
import { checkV2CostCap } from "./cost-guard";

function mapV2AutonomyToPrisma(mode: V2AgentConfig["autonomyMode"]): "AUTONOMOUS" | "DRAFT" {
  return mode === "auto" ? "AUTONOMOUS" : "DRAFT";
}

const QUERY_TOOL_NAMES = new Set([
  "search_products",
  "search_crm_records",
  "knowledge_search",
  "list_message_models",
]);

function isEmptyQueryResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if ("total" in r && typeof r.total === "number") return r.total === 0;
  if ("products" in r && Array.isArray(r.products)) return r.products.length === 0;
  if ("contacts" in r || "deals" in r) {
    return (
      (!Array.isArray(r.contacts) || r.contacts.length === 0) &&
      (!Array.isArray(r.deals) || r.deals.length === 0)
    );
  }
  if ("chunks" in r && Array.isArray(r.chunks)) return r.chunks.length === 0;
  if ("models" in r && Array.isArray(r.models)) return r.models.length === 0;
  return false;
}

function allQueryToolResultsEmpty(
  toolCalls: Array<{ toolName: string; result: unknown }> | undefined,
): boolean {
  if (!toolCalls || toolCalls.length === 0) return false;
  const queryCalls = toolCalls.filter((c) => QUERY_TOOL_NAMES.has(c.toolName));
  if (queryCalls.length === 0) return false;
  return queryCalls.every((c) => isEmptyQueryResult(c.result));
}

function resolveHandoffDestination(
  config: V2AgentConfig,
  destination: V2Destination,
  counters: V2Counters,
): V2Destination {
  if (destination.type === "ai_agent" && counters.aiTransferCount >= config.limits.maxAiTransfers) {
    return config.handoff.defaultDestination;
  }
  return destination;
}

export type V2TurnInput = {
  conversationId: string;
  channel: "meta" | "baileys" | string;
  userMessage: string;
  messageType?: string;
  turnId?: string;
  /** Mensagens do cliente neste turno (áudio/imagem viram texto a partir delas). */
  messageIds?: string[];
};

export type V2TurnResult = {
  sentReply?: string;
  handoff: boolean;
  closed: boolean;
  error?: string;
};

const STAGES_ORDERED: V2Stage[] = ["idle", "confirming", "identifying", "active", "closed"];

const MEDIA_ASK_TEXT_DEFAULT: Record<string, string> = {
  audio: "Não consigo ouvir áudios por aqui. Pode me escrever o que precisa?",
  image: "Não consigo ver imagens por aqui. Pode me escrever o que aparece nela?",
  document: "Não consigo abrir arquivos por aqui. Pode me escrever o que precisa?",
};
const MEDIA_NOT_UNDERSTOOD_DEFAULT: Record<string, string> = {
  audio: "Não consegui entender o seu áudio. Pode me escrever o que precisa?",
  image: "Não consegui ler a sua imagem. Pode me escrever o que aparece nela?",
  document: "Não consegui abrir o seu arquivo. Pode me escrever o que precisa?",
};

function ownerToPrisma(owner: V2Owner): string {
  return owner === "automation" ? "automation" : owner;
}

function prismaToOwner(raw: string): V2Owner {
  if (raw === "pessoa") return "pessoa";
  if (raw === "automation") return "automation";
  if (raw === "ninguem") return "ninguem";
  return "agente";
}

async function loadAgentConfig(agentConfigId: string): Promise<{ config: V2AgentConfig; active: boolean; versionId?: string } | null> {
  const row = await (prisma as unknown as {
    aIAgentConfig: {
      findUnique: (args: { where: { id: string }; select: { simpleConfig: boolean; id: boolean; active: boolean } }) => Promise<{ id: string; simpleConfig: unknown; active: boolean } | null>;
    };
  }).aIAgentConfig.findUnique({
    where: { id: agentConfigId },
    select: { id: true, simpleConfig: true, active: true },
  });
  if (!row || !row.simpleConfig) return null;
  try {
    const config = normalizeV2Config(row.simpleConfig);
    return { config, active: row.active ?? true, versionId: row.id };
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

async function getConversationPhone(conversationId: string): Promise<string | null> {
  const conv = await (prisma as unknown as {
    conversation: {
      findUnique: (args: {
        where: { id: string };
        select: { contact: { select: { phone: boolean } } };
      }) => Promise<{ contact: { phone: string | null } | null } | null>;
    };
  }).conversation.findUnique({
    where: { id: conversationId },
    select: { contact: { select: { phone: true } } },
  });
  return conv?.contact?.phone ?? null;
}

function isPhoneAllowed(config: V2AgentConfig, phone: string | null): boolean {
  const allowed = config.allowedPhoneNumbers ?? [];
  if (allowed.length === 0) return true;
  if (!phone) return false;
  const allowSet = new Set(allowed.map((a) => normalizePhoneDigits(a)).filter(Boolean));
  return phoneMatchesAllowlist(phone, allowSet);
}

function mergeCollectedVariables(
  existing: Record<string, unknown>,
  collected: Record<string, string>,
): Record<string, unknown> {
  return { ...existing, ...collected };
}

/** Aviso do "avisar e silenciar". Usa a mensagem de escopo quando configurada. */
function stopWarning(config: V2AgentConfig, reason: string): string {
  if (reason === "loop detectado") {
    return "Recebi a mesma mensagem algumas vezes. Se precisar de algo diferente, me conta com outras palavras.";
  }
  return config.scope?.message || "Aqui eu só consigo ajudar com o atendimento. Quando precisar de algo sobre isso, é só me chamar.";
}

/** Uma linha para o rastro: o que o modelo consultou e o que voltou. */
function describeToolCall(call: { toolName: string; args: unknown; result: unknown }): string {
  const args = (call.args ?? {}) as { query?: unknown };
  const query = typeof args.query === "string" ? ` "${args.query}"` : "";
  const r = (call.result ?? {}) as Record<string, unknown>;
  if (r.ok === false) return `${call.toolName}${query} → erro: ${String(r.error ?? "")}`;
  const names = (list: unknown, key: string) =>
    Array.isArray(list) ? (list as Array<Record<string, unknown>>).map((i) => String(i[key] ?? "?")) : [];
  let found: string[] = [];
  if (call.toolName === "knowledge_search") found = [...new Set(names(r.chunks, "docTitle"))];
  else if (call.toolName === "search_products") found = names(r.products, "name");
  else if (call.toolName === "list_message_models") found = names(r.models, "name");
  else if (call.toolName === "search_crm_records") {
    found = [...names(r.contacts, "name"), ...names(r.deals, "title")];
  }
  return `${call.toolName}${query} → ${found.length ? found.join(", ") : "nada encontrado"}`;
}

/** Variáveis gravadas por ações `set_variable` bem-sucedidas. */
function variablesFromActions(results: V2ActionResult[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of results) {
    if (r.action.type !== "set_variable" || !r.ok) continue;
    const key = typeof r.key === "string" ? r.key.trim() : "";
    if (key) out[key] = r.value;
  }
  return out;
}

function messageVariables(config: V2AgentConfig, context: V2CRMContext): Record<string, unknown> {
  return buildVariableMap(
    config.variables,
    context.contact,
    context.selectedDeal,
    context.contactRaw,
    context.selectedDealRaw,
  );
}

/**
 * Turno do motor v2 com rastro: cada decisão vira um passo no log do turno
 * (tela de conversas de teste e diagnóstico de erro). Turno que termina sem
 * gravar log (agente inativo, fora da lista de teste…) grava um registro
 * com o motivo — senão a conversa de teste mostraria um buraco.
 */
export async function processV2Turn(input: V2TurnInput): Promise<V2TurnResult> {
  return runWithV2Trace(async () => {
    traceStep("entrada", `Mensagem recebida (${input.messageType ?? "texto"})`);
    const result = await processV2TurnInner(input);
    if (result.error && !v2TraceWasLogged()) {
      traceStep("parada", `Turno encerrado sem resposta: ${result.error}`);
      await logTurnWithoutResponse(input, result.error).catch(() => {});
    }
    return result;
  });
}

async function logTurnWithoutResponse(input: V2TurnInput, error: string): Promise<void> {
  const conv = await (prisma as unknown as {
    conversation: {
      findUnique: (args: unknown) => Promise<{
        organizationId: string;
        assignedTo?: { aiAgentConfig?: { id: string } | null } | null;
      } | null>;
    };
  }).conversation.findUnique({
    where: { id: input.conversationId },
    select: { organizationId: true, assignedTo: { select: { aiAgentConfig: { select: { id: true } } } } },
  });
  const agentId = conv?.assignedTo?.aiAgentConfig?.id;
  if (!conv || !agentId) return;
  await logV2Turn({
    organizationId: conv.organizationId,
    conversationId: input.conversationId,
    agentId,
    turnId: input.turnId,
    inboundText: input.userMessage,
    crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } } as V2CRMContext,
    prompt: "",
    executedActions: [],
    discardedActions: [],
    handoff: false,
    error,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    owner: "agente",
    stage: "idle",
  });
}

async function processV2TurnInner(input: V2TurnInput): Promise<V2TurnResult> {
  const startedAt = Date.now();
  // DEV não aplica migrations no deploy: garante draftConfig e
  // collectedVariables antes de tocar no estado da conversa.
  try {
    await ensureV2AgentSchema();
  } catch (err) {
    console.error("[ai-v2] ensureV2AgentSchema falhou", err);
  }
  const resolved = await resolveV2AgentForConversation(input.conversationId);
  if (!resolved) {
    return { handoff: false, closed: false, error: "No v2 agent assigned" };
  }

  traceStep("agente", resolved.wasAssigned
    ? "Conversa estava sem responsável e foi atribuída ao agente agora"
    : "Conversa já estava com o agente");
  const agent = await loadAgentConfig(resolved!.agentConfigId);
  if (!agent) {
    return { handoff: false, closed: false, error: "Agent config not found or invalid" };
  }
  if (!agent.active) {
    return { handoff: false, closed: false, error: "Agent inactive" };
  }
  const config = agent.config;
  void import("@/services/ai/knowledge-docs")
    .then(({ healLegacyKnowledgeDocs }) => healLegacyKnowledgeDocs(resolved.agentConfigId))
    .catch(() => undefined);

  const contactId = await getConversationContact(input.conversationId) ?? undefined;
  if (!contactId) {
    return { handoff: false, closed: false, error: "Conversation without contact" };
  }

  // Kill-switch da org: mesmo comportamento do v1 (inbox-handler) — não
  // responde e manda o ticket para a distribuição humana.
  if (!(await isAiAttendanceEnabled())) {
    const { maybeDistributeNewInboundTicket } = await import("@/services/distribution");
    await maybeDistributeNewInboundTicket({
      conversationId: input.conversationId,
      contactId,
      assignedToId: resolved.userId,
    });
    return { handoff: false, closed: false, error: "AI attendance disabled" };
  }

  // Filtro de números de teste: se a config restringe telefones, ignora
  // qualquer outro número mesmo com agente ativo/canal vinculado.
  const phone = await getConversationPhone(input.conversationId);
  if (!isPhoneAllowed(config, phone)) {
    return { handoff: false, closed: false, error: "Phone number not in allowed test list" };
  }
  // Fase de teste (lista de números) = conversa de teste; sem lista, produção.
  noteV2Fact("source", (config.allowedPhoneNumbers ?? []).length > 0 ? "test" : "production");

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

  // Estado (necessário antes de ações que precisam de owner/stage/versionId)
  let stateRow = await getV2ConversationState(input.conversationId);
  if (!stateRow) {
    const inherited = await findInheritablePostCloseState({
      contactId,
      conversationId: input.conversationId,
      agentId: resolved.agentConfigId,
    }).catch(() => null);
    if (inherited) {
      traceStep("estado", "Ticket novo herdou a janela pós-encerramento do atendimento anterior do contato");
      stateRow = await upsertV2ConversationState({
        organizationId: orgId,
        conversationId: input.conversationId,
        agentId: resolved.agentConfigId,
        stage: "closed",
        owner: "ninguem",
        postCloseWindowEndAt: inherited.postCloseWindowEndAt ?? null,
        closeReason: inherited.closeReason ?? null,
        selectedDealId: inherited.selectedDealId ?? null,
        counters: parseV2Counters(inherited.counters),
        collectedVariables: (inherited.collectedVariables as Record<string, unknown> | null) ?? {},
        versionId: inherited.versionId ?? agent.versionId ?? null,
      });
    }
  }
  let stage: V2Stage = (stateRow?.stage as V2Stage) ?? "idle";
  let owner: V2Owner = stateRow ? prismaToOwner(stateRow.owner) : "agente";
  const humanBehavior = v2HumanBehavior(config);
  let counters = parseV2Counters(stateRow?.counters);
  // Opções da última resposta (botões/lista/numeradas): o clique ou o número
  // ("2") vira o rótulo da opção, que é o que o modelo e as regras entendem.
  // Valem só para a próxima mensagem do cliente.
  const pendingOptions = counters.pendingOptions ?? [];
  if (pendingOptions.length > 0) {
    counters.pendingOptions = undefined;
    const chosen = matchPendingOption(pendingOptions, input.userMessage);
    if (chosen) {
      traceStep("opções", `Cliente escolheu a opção "${chosen}"`);
      if (chosen !== input.userMessage.trim()) input = { ...input, userMessage: chosen };
    }
  }
  traceStep("estado", stateRow
    ? `Etapa "${stage}", dono "${owner}"`
    : "Primeiro turno deste atendimento (sem estado anterior)");
  let themeId: string | undefined = stateRow?.themeId ?? undefined;
  // Assunto escolhido por atalho neste turno: vale sobre gatilhos e sentido.
  let themeFromRule = false;
  // Para o fecho das respostas: não repetir a frase da mensagem anterior e alternar.
  let lastAgentMessage: string | null = null;
  let historyLength = 0;
  let versionId: string | undefined = stateRow?.versionId ?? agent.versionId ?? undefined;
  // A conversa está atribuída a este agente v2. owner=pessoa aqui é estado
  // antigo (humano anterior ou handoff que não trocou o responsável) e
  // deixava o motor mudo mesmo com o agente como assignee.
  if (owner === "pessoa") {
    owner = "agente";
    await upsertV2ConversationState({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved.agentConfigId,
      owner: "agente",
      versionId,
    });
  }

  // Contexto CRM (necessário para regras e mídia)
  let loadedContext = await loadV2Context({
    organizationId: orgId,
    conversationId: input.conversationId,
    contactId,
    config,
    selectedDealId: stateRow?.selectedDealId ?? undefined,
  });

  const context: V2CRMContext = {
    contact: loadedContext.contact,
    contactRaw: loadedContext.contactRaw,
    citableContact: loadedContext.citableContact,
    deals: loadedContext.deals,
    selectedDeal: loadedContext.selectedDeal,
    selectedDealRaw: loadedContext.selectedDealRaw,
    citableDeal: loadedContext.citableDeal,
    fields: config.contextFields,
  };

  const vars = { ...messageVariables(config, context) };

  function renderConfirmationText(): string {
    const rendered = renderMessage(
      config.entry.confirmationMessage ?? "Confirmo que estou falando com você. Como posso ajudar?",
      vars,
      defaultFormatter(),
    );
    return applyConfirmationIdentity(rendered, confirmationIdentityValues({
      fieldKeys: config.entry.confirmationFields ?? [],
      fieldLabels: [...config.contextFields.contact, ...config.contextFields.deal],
      sources: [loadedContext.contactRaw, loadedContext.selectedDealRaw, loadedContext.contact, loadedContext.selectedDeal],
    }));
  }

  // Se há vários negócios abertos e o operador configurou "perguntar",
  // tenta interpretar a resposta do cliente como escolha de negócio.
  if (
    config.dealSelection === "ask" &&
    loadedContext.deals.length > 1 &&
    !loadedContext.selectedDeal &&
    contactId
  ) {
    const chosenDealId = tryParseDealChoice(input.userMessage, loadedContext.deals, config);
    if (chosenDealId) {
      await upsertV2ConversationState({
        organizationId: orgId,
        conversationId: input.conversationId,
        agentId: resolved!.agentConfigId,
        selectedDealId: chosenDealId,
        versionId,
      });
      // Recarrega contexto com o negócio escolhido e continua o fluxo normal.
      loadedContext = await loadV2Context({
        organizationId: orgId,
        conversationId: input.conversationId,
        contactId,
        config,
        selectedDealId: chosenDealId,
      });
      context.selectedDeal = loadedContext.selectedDeal;
      context.citableDeal = loadedContext.citableDeal;
      Object.assign(vars, messageVariables(config, context));
    } else {
      const askMessage = buildAskDealMessage(loadedContext.deals, config);
      await sendV2TextMessage({
        conversationId: input.conversationId,
        contactId,
        agentUserId: resolved!.userId,
        text: askMessage,
        channel: input.channel,
        autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
        humanBehavior,
      });
      await logV2Turn({
        organizationId: orgId,
        conversationId: input.conversationId,
        agentId: resolved!.agentConfigId,
        turnId: input.turnId,
        inboundText: input.userMessage,
        crmContext: context,
        prompt: askMessage,
        reply: askMessage,
        executedActions: [],
        discardedActions: [],
        handoff: false,
        closed: false,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        owner,
        stage,
        versionId,
      });
      return { handoff: false, closed: false, sentReply: askMessage };
    }
  }

  // Bridge automação
  const bridge = await loadV2AutomationBridge(contactId);
  const automationVariables = mapAutomationVariables(bridge, config);
  for (const [k, v] of Object.entries(automationVariables)) vars[k] = v;

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
    traceStep("pós-encerramento", `Dentro da janela pós-encerramento: mensagem classificada como "${caseType}" → comportamento "${behavior}"`);

    // O contador de cortesia só vale dentro da janela e precisa ser salvo em
    // todo ramo que encerra o turno aqui — antes nunca era, e o limite de
    // respostas de cortesia não disparava ("Por nada!" em loop).
    const persistPostCloseCounters = () =>
      upsertV2ConversationState({
        organizationId: orgId,
        conversationId: input.conversationId,
        agentId: resolved!.agentConfigId,
        counters,
        versionId,
      });
    // Cortesia sem nova demanda: o ticket aberto pelo "obrigado" não fica
    // pendurado aberto com a IA na Entrada.
    const reResolveCourtesyTicket = async () => {
      const { resolveConversationsInline } = await import("@/services/conversations");
      await resolveConversationsInline({
        ids: [input.conversationId],
        keepAgent: true,
        keepDepartment: true,
        tabulation: null,
      });
    };

    if (caseType === "courtesy") {
      counters.courtesyReplies += 1;
      if (counters.courtesyReplies > config.limits.maxCourtesyReplies) {
        await persistPostCloseCounters();
        await reResolveCourtesyTicket();
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

    if (behavior === "no_reply") {
      // Padrão para cortesia pós-encerramento ("obrigado", "valeu"). Não
      // tinha ramo: caía no fluxo normal e o LLM respondia de novo.
      await persistPostCloseCounters();
      await reResolveCourtesyTicket();
      await logV2Turn({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
        inboundText: input.userMessage,
        crmContext: context,
        prompt: "", executedActions: [], discardedActions: [{ type: "no_reply", reason: "post-close no_reply" } as any],
        handoff: false, closed: true, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, owner, stage, versionId,
      });
      return { handoff: false, closed: true };
    } else if (behavior === "reopen_and_route") {
      stage = "active";
      owner = "agente";
      counters.courtesyReplies = 0;
      await upsertV2ConversationState({
        organizationId: orgId,
        conversationId: input.conversationId,
        agentId: resolved!.agentConfigId,
        stage,
        owner,
        postCloseWindowEndAt: null,
        counters,
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
        autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
        humanBehavior,
      });
      await persistPostCloseCounters();
      await reResolveCourtesyTicket();
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
        autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
        humanBehavior,
      });
      await persistPostCloseCounters();
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

  // Fora da janela pós-encerramento o limite de cortesia não se aplica —
  // sem zerar, uma cortesia antiga bloquearia toda resposta futura.
  counters.courtesyReplies = 0;

  // Mídia recebida
  const media = evaluateV2Media(config, input.messageType);
  if (media) traceStep("mídia", `Recebeu ${media.kind} → política "${media.action}"`);

  // "Pedir para escrever" e "não entendi": responde e espera o cliente, sem
  // transferir e sem chamar o modelo.
  const replyAndWait = async (text: string, reason: string): Promise<V2TurnResult> => {
    const reply = renderMessage(text, vars, defaultFormatter());
    await sendV2TextMessage({
      conversationId: input.conversationId,
      contactId,
      agentUserId: resolved!.userId,
      text: reply,
      channel: input.channel,
      autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
      humanBehavior,
    });
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context, prompt: reason, reply,
      executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, versionId,
    });
    return { handoff: false, closed: false, sentReply: reply };
  };

  // O turno junta as bolhas seguidas; só o tipo da última decidia. Texto +
  // áudio com "pedir texto" respondia "não consigo ouvir" ignorando o texto,
  // e áudio + texto nem transcrevia o áudio.
  const turnLines = input.userMessage.split(/\r?\n/).filter((l) => l.trim());
  const turnHasText = turnLines.some((l) => !isMediaPlaceholderText(l));
  const turnHasMedia = turnLines.some((l) => isMediaPlaceholderText(l));
  if (media && media.action === "ask_text") {
    if (!turnHasText) return replyAndWait(media.message || MEDIA_ASK_TEXT_DEFAULT[media.kind], "media ask_text");
    traceStep("mídia", "Mídia veio junto com texto → responde o texto");
  }
  if (turnHasMedia && (input.messageIds?.length ?? 0) > 0) {
    const enriched = await enrichTurnWithMedia({
      organizationId: orgId,
      agentUserId: resolved!.userId,
      agentConfigId: resolved!.agentConfigId,
      config,
      userMessage: input.userMessage,
      messageIds: input.messageIds ?? [],
    });
    if (enriched.understood > 0) {
      input = { ...input, userMessage: enriched.userMessage };
    } else if (enriched.failed > 0 && !turnHasText && media) {
      const kindCfg = media.kind === "audio" ? config.media.audio : media.kind === "image" ? config.media.image : config.media.document;
      return replyAndWait(kindCfg.notUnderstoodMessage || MEDIA_NOT_UNDERSTOOD_DEFAULT[media.kind], "media not understood");
    }
  }
  if (media && media.action === "handoff") {
    noteV2Fact("handoffCause", "media", { keepFirst: true });
    const handoffMessage = renderMessage(media.message ?? config.handoff.message, vars, defaultFormatter());
    await sendV2TextMessage({
      conversationId: input.conversationId,
      contactId,
      agentUserId: resolved!.userId,
      text: handoffMessage,
      channel: input.channel,
      autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
      humanBehavior,
    });
    const mediaDestination = resolveHandoffDestination(config, config.handoff.defaultDestination, counters);
    if (mediaDestination.type === "ai_agent") counters.aiTransferCount += 1;
    await simpleHandoff({
      conversationId: input.conversationId,
      contactId,
      dealId: loadedContext.dealId,
      destination: mediaDestination,
    });
    await upsertV2ConversationState({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      owner: "pessoa",
      counters: counters as V2Counters,
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
  const withinBusinessHours = isWithinV2BusinessHours(config);
  // As condições comparam pela CHAVE do campo (tags, stageName,
  // field_equals). O contexto do prompt é indexado pelo rótulo exibido,
  // então com ele essas regras nunca casavam — usa o dado bruto.
  const ruleContext: V2CRMContext = {
    ...context,
    contact: loadedContext.contactRaw ?? null,
    selectedDeal: loadedContext.selectedDealRaw ?? null,
  };
  const rule = evaluateV2Rules(config, {
    userMessage: input.userMessage,
    messageType: input.messageType,
    isFirstMessage: !stateRow || (stateRow.stage as V2Stage) === "idle",
    contactTags: (loadedContext.contactRaw?.tags as string[] | undefined) ?? [],
    dealStageName: loadedContext.selectedDealRaw?.stageName as string | undefined,
    withinBusinessHours,
    mediaKinds: media ? [media.kind] : [],
    surveyReceived: counters.surveyPending,
  }, ruleContext);

  let appliedRuleId = rule?.id;
  traceStep("regra", rule
    ? `Regra "${rule.name ?? rule.id}" casou → ações: ${(rule.actions as Array<{ type: string }>).map((a) => a.type).join(", ") || "nenhuma"}`
    : "Nenhuma regra automática casou", rule ? { ruleId: rule.id } : undefined);

  // Limites de parada: avaliados UMA vez por turno (a detecção de loop soma
  // a cada chamada; antes contava duas vezes quando uma regra casava).
  const stop = evaluateV2StopLimits(config, counters, input.userMessage);
  if (stop.blocksReply) traceStep("limites", `Limite de parada atingido: ${stop.reason} → ${stop.action}`);

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
  // Memória da conversa: o que já foi coletado em turnos anteriores +
  // variáveis da automação de origem (estas têm precedência).
  let collectedVariables: Record<string, unknown> = {
    ...((stateRow?.collectedVariables as Record<string, unknown> | null | undefined) ?? {}),
    ...automationVariables,
  };

  // Regra determinística: executa ações; se for terminal (handoff/close/mensagem),
  // encerra o turno; se for set_theme/set_variable, segue para o LLM com estado atualizado.
  if (rule) {
    const actionCtx = buildActionCtx(resolved!.userId, resolved!.agentConfigId, orgId, config, loadedContext, input, contactId, mapV2AutonomyToPrisma(config.autonomyMode), (v) => { counters.surveyPending = v; });

    let ruleActions = rule.actions as unknown as V2Action[];
    const replyActionTypes = new Set(["send_message", "send_message_model", "send_whatsapp_template"]);
    if (stop.blocksReply && ruleActions.some((a) => replyActionTypes.has(a.type))) {
      ruleActions = ruleActions.filter((a) => !replyActionTypes.has(a.type));
      if (stop.action === "handoff") {
        noteV2Fact("handoffCause", "limit", { keepFirst: true });
        ruleActions.push({ type: "handoff" });
      }
      else if (stop.action === "close") ruleActions.push({ type: "close_conversation" });
      else if (stop.action === "silence" || stop.action === "none") {
        // A resposta da regra foi bloqueada pelos limites de parada. Encerra o
        // turno sem enviar nada e sem chamar o LLM, evitando duas mensagens do
        // agente seguidas.
        await logV2Turn({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
          inboundText: input.userMessage, crmContext: context, prompt: "rule", reply: undefined,
          executedActions, discardedActions: [], handoff: false, closed: false, latencyMs: Date.now() - startedAt,
          inputTokens: 0, outputTokens: 0, owner, stage, appliedRuleId, versionId,
        } as any);
        await upsertV2ConversationState({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
          owner, counters: counters as V2Counters, versionId: versionId, collectedVariables,
        });
        return { handoff: false, closed: false };
      }
    }

    // Handoff da regra sai do executor genérico: primeiro roda o resto,
    // depois avisa o cliente e só então transfere. Transferir antes fazia a
    // mensagem de transferência morrer na checagem de responsável.
    const ruleHandoff = ruleActions.find((a) => a.type === "handoff");
    const otherRuleActions = ruleActions.filter((a) => a.type !== "handoff");
    const res = await executeV2Actions(otherRuleActions, actionCtx);
    executedActions = res.results;
    anyClose = res.anyClose;
    if (res.themeId) {
      themeId = res.themeId;
      themeFromRule = true;
    }
    Object.assign(collectedVariables, variablesFromActions(res.results));

    let ruleReply: string | undefined;
    if (ruleHandoff) {
      // Atalho que casa as palavras de "pedir atendente" é pedido de pessoa.
      noteV2Fact("handoffCause", mentionsHumanRequest(config, input.userMessage) ? "human_request" : "rule", { keepFirst: true });
      const ruleAlreadyReplied = otherRuleActions.some((a) => replyActionTypes.has(a.type));
      ruleReply = await performHandoff(ruleHandoff.destination as V2Destination | undefined, { skipMessage: ruleAlreadyReplied });
      executedActions.push({ action: ruleHandoff, ok: true });
      anyHandoff = true;
    }

    const terminalTypes = new Set(["handoff", "close_conversation", "no_reply", "send_message", "send_message_model", "send_whatsapp_template"]);
    // Só encerra o turno a ação terminal que deu certo. Uma ação salva sem
    // parâmetro (mensagem vazia, modelo não escolhido) falhava e o cliente
    // ficava sem resposta; agora o turno segue para o agente.
    const isTerminal = executedActions.some((r) => r.ok && terminalTypes.has(r.action.type as string));
    const failedTerminal = executedActions.filter((r) => !r.ok && terminalTypes.has(r.action.type as string));
    if (failedTerminal.length > 0) {
      traceStep("regra", `Ação da regra falhou (${failedTerminal.map((r) => `${r.action.type}${r.error ? `: ${r.error}` : ""}`).join("; ")}) → segue para o agente`);
    }

    // Logs e saída
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context, prompt: "rule", reply: ruleReply,
      executedActions, discardedActions: [], handoff: anyHandoff, closed: anyClose, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, appliedRuleId, versionId,
    });

    if (anyHandoff) {
      await upsertV2ConversationState({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
        owner: "pessoa", counters: counters as V2Counters, versionId: versionId, collectedVariables,
      });
      return { handoff: true, closed: false, sentReply: ruleReply };
    }
    if (anyClose) {
      await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, "rule", loadedContext.contactId, collectedVariables);
      return { handoff: false, closed: true };
    }
    if (isTerminal) {
      await upsertV2ConversationState({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
        counters: counters as V2Counters, versionId: versionId, collectedVariables,
      });
      return { handoff: false, closed: false };
    }
  }

  // Pedido que já veio na primeira mensagem: o assunto fica escolhido para o
  // turno que responde depois da confirmação (o "sim" sozinho não diz nada).
  const pendingTheme = async (): Promise<string | undefined> => {
    if ((config.themes ?? []).length === 0) return undefined;
    const sel = await selectV2ThemeSemantic({
      config,
      message: input.userMessage,
      apiKey: await tryGetAgentApiKey(resolved!.agentConfigId),
    }).catch(() => null);
    if (!sel?.theme) return undefined;
    traceStep("assunto", `Pedido na primeira mensagem → assunto "${sel.theme.name}" guardado para depois da confirmação`, { method: sel.method, themeId: sel.theme.id });
    noteV2Fact("theme", { method: sel.method, themeId: sel.theme.id, similarity: sel.similarity ?? null });
    return sel.theme.id;
  };

  // Fluxo de entrada (boas-vindas / confirmação / identificação)
  if (stage === "idle" || stage === "confirming" || stage === "identifying") {
    if (!loadedContext.selectedDeal) {
      const onDealNotFound = config.entry.onDealNotFound;
      traceStep("entrada", `Nenhum negócio do contato encontrado → "${onDealNotFound}"`);
      if (onDealNotFound === "handoff") {
        noteV2Fact("handoffCause", "identification", { keepFirst: true });
        await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, "Não encontrei seu cadastro. Vou transferir para um atendente.", counters);
        return { handoff: true, closed: false };
      } else if (onDealNotFound === "create_deal") {
        const created = await createInitialDeal(contactId);
        if (!created) {
          noteV2Fact("handoffCause", "identification", { keepFirst: true });
          // Sem funil/etapa para criar o negócio: melhor um humano do que um
          // turno que falha e é reprocessado até virar FAILED sem resposta.
          await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, renderMessage(config.handoff.message, vars, defaultFormatter()), counters);
          return { handoff: true, closed: false };
        }
        // Recarrega: o resto do turno (prompt, ações) precisa enxergar o
        // negócio recém-criado.
        loadedContext = await loadV2Context({
          organizationId: orgId,
          conversationId: input.conversationId,
          contactId,
          config,
          selectedDealId: created,
        });
        context.contact = loadedContext.contact;
        context.contactRaw = loadedContext.contactRaw;
        context.citableContact = loadedContext.citableContact;
        context.deals = loadedContext.deals;
        context.selectedDeal = loadedContext.selectedDeal;
        context.selectedDealRaw = loadedContext.selectedDealRaw;
        context.citableDeal = loadedContext.citableDeal;
        Object.assign(vars, messageVariables(config, context));
        stage = "active";
      } else {
        // O motor não identifica pela resposta do cliente (não há busca por
        // e-mail/CPF). Antes repetia a mesma pergunta para sempre e, da 2ª
        // vez em diante, a trava anti-repetição engolia o envio: o cliente
        // ficava sem resposta. Agora pergunta até `entry.maxAttempts` vezes
        // (a 2ª com outro texto) e depois transfere para humano.
        const asked = stage === "identifying" ? Math.max(1, stateRow?.identificationAttempts ?? 1) : 0;
        if (asked >= (config.entry.maxAttempts ?? 2)) {
          noteV2Fact("handoffCause", "identification", { keepFirst: true });
          await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, renderMessage(config.handoff.message, vars, defaultFormatter()), counters);
          return { handoff: true, closed: false };
        }
        const parts: string[] = [];
        if (asked === 0) {
          if (config.entry.openingEnabled && config.entry.openingMessage) {
            parts.push(renderMessage(config.entry.openingMessage, vars, defaultFormatter()));
          }
          parts.push(renderMessage(config.entry.identificationMessage ?? "Preciso confirmar seus dados. Qual o seu e-mail ou CPF?", vars, defaultFormatter()));
        } else {
          parts.push("Ainda não localizei seu cadastro com essa informação. Pode me enviar outro dado, como o e-mail ou o telefone usado no cadastro?");
        }
        const identMsg = parts.filter(Boolean).join("\n\n");
        await sendReply(identMsg);
        await upsertV2ConversationState({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
          stage: "identifying", versionId: versionId, identificationAttempts: asked + 1,
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
      const mode = config.entry.confirmationMode ?? "combined";
      traceStep("entrada", `Primeiro contato: boas-vindas e confirmação de identidade (${mode === "combined" ? "na mesma mensagem" : "em turnos separados"})`);
      const entryTheme = await pendingTheme();
      if (mode === "separate_turn") {
        const welcomeMsg = config.entry.openingEnabled && config.entry.openingMessage
          ? renderMessage(config.entry.openingMessage, vars, defaultFormatter())
          : "";
        if (welcomeMsg) {
          await sendReply(welcomeMsg);
        }
        await upsertV2ConversationState({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
          stage: "confirming", versionId: versionId, entryConfirmationPending: true,
          ...(entryTheme ? { themeId: entryTheme } : {}),
        });
        await logV2Turn({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
          inboundText: input.userMessage, crmContext: context, prompt: "welcome", reply: welcomeMsg,
          executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
          inputTokens: 0, outputTokens: 0, owner, stage: "confirming", versionId, themeId: entryTheme,
        });
        return { handoff: false, closed: false, sentReply: welcomeMsg };
      }

      const parts: string[] = [];
      if (config.entry.openingEnabled && config.entry.openingMessage) {
        parts.push(renderMessage(config.entry.openingMessage, vars, defaultFormatter()));
      }
      parts.push(renderConfirmationText());
      const confirmMsg = parts.filter(Boolean).join("\n\n");
      await sendReply(confirmMsg);
      await upsertV2ConversationState({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
        stage: "confirming", versionId: versionId, entryConfirmationPending: false,
        ...(entryTheme ? { themeId: entryTheme } : {}),
      });
      await logV2Turn({
        organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
        inboundText: input.userMessage, crmContext: context, prompt: "confirmation", reply: confirmMsg,
        executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
        inputTokens: 0, outputTokens: 0, owner, stage: "confirming", versionId, themeId: entryTheme,
      });
      return { handoff: false, closed: false, sentReply: confirmMsg };
    } else if (stage === "idle") {
      stage = "active";
    }
  }

  // Confirmação adiada: no turno seguinte às boas-vindas, pergunta a confirmação.
  if (stage === "confirming" && stateRow?.entryConfirmationPending && config.entry.confirmContact) {
    const confirmMsg = renderConfirmationText();
    if (confirmMsg.trim()) {
      await sendReply(confirmMsg);
    }
    await upsertV2ConversationState({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      stage: "confirming",
      versionId: versionId,
      entryConfirmationPending: false,
    });
    await logV2Turn({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: context,
      prompt: "confirmation",
      reply: confirmMsg,
      executedActions: [],
      discardedActions: [],
      handoff: false,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      owner,
      stage: "confirming",
      versionId,
    });
    return { handoff: false, closed: false, sentReply: confirmMsg };
  }

  // Onboarding
  let onboardingActive = false;
  if (config.flow === "onboarding" && config.onboarding && stage === "active") {
    const prevState = parseV2OnboardingState(collectedVariables.onboarding_state);
    const step = currentV2OnboardingStep(config.onboarding, prevState);
    // Sem passo pendente o onboarding acabou: segue para o LLM normal. Antes
    // `onboardingActive` ficava true sem LLM e todo turno virava handoff.
    if (step) {
      onboardingActive = true;
      const llmForStep = await callLLMWithTheme(config, context, input, resolved, themeId, collectedVariables, rule, owner, stage);
      llmOutput = llmForStep.llmOutput;
      prompt = llmForStep.prompt;
      inputTokens = llmForStep.inputTokens;
      outputTokens = llmForStep.outputTokens;
      latencyMs = llmForStep.latencyMs;
      toolCalls = llmForStep.toolCalls;
      governorStats = llmForStep.governorStats;

      if (llmOutput && isV2OnboardingStepCompleted(step, context, llmOutput)) {
        const nextState = advanceV2OnboardingState(config.onboarding, prevState, step.id);
        collectedVariables.onboarding_state = nextState as unknown as Record<string, unknown>;
      } else {
        const nextState = incrementStepAttempt(prevState, step.id);
        collectedVariables.onboarding_state = nextState as unknown as Record<string, unknown>;
        if (shouldHandoffOnboardingStep(step, nextState)) {
          noteV2Fact("handoffCause", "onboarding", { keepFirst: true });
          const sent = await performHandoff(step.handoffOnStuck);
          await upsertV2ConversationState({ organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, owner: "pessoa", counters: counters as V2Counters, versionId: versionId, collectedVariables });
          await logV2Turn({
            organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
            inboundText: input.userMessage, crmContext: context, prompt, llmOutput, reply: sent,
            executedActions: [{ action: { type: "handoff" }, ok: true }], discardedActions: [], handoff: true,
            latencyMs, inputTokens, outputTokens, owner: "pessoa", stage, themeId, appliedRuleId, versionId, toolCalls, governorStats,
          });
          return { handoff: true, closed: false, sentReply: sent };
        }
      }
    }
  }

  // LLM normal
  if (!onboardingActive) {
    // Teto diário de tokens do agente. Existia na tela/schema mas o
    // cost-guard nunca era chamado.
    const cap = await checkV2CostCap({
      config,
      agentId: resolved.agentConfigId,
      organizationId: orgId,
      inputTokens: 0,
      outputTokens: 0,
    }).catch(() => ({ allowed: true as const }));
    if (!cap.allowed) {
      noteV2Fact("handoffCause", "cost_cap", { keepFirst: true });
      await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, renderMessage(config.handoff.message, vars, defaultFormatter()), counters, themeId);
      return { handoff: true, closed: false };
    }

    // Atalho > gatilho > significado > assunto atual (ver theme-semantic).
    const selection: V2ThemeSelection = themeFromRule
      ? { theme: getV2ThemeById(config, themeId), method: "kept" }
      : await selectV2ThemeSemantic({
          config,
          message: input.userMessage,
          currentThemeId: themeId,
          apiKey: await tryGetAgentApiKey(resolved.agentConfigId),
        });
    themeId = selection.theme?.id ?? themeId;
    traceStep("assunto", selection.theme
      ? `Assunto "${selection.theme.name}" — ${
          selection.method === "trigger"
            ? "um gatilho casou com a mensagem"
            : selection.method === "semantic"
              ? `mais próximo em significado (similaridade ${selection.similarity?.toFixed(2)})`
              : "mantido o assunto da conversa"
        }`
      : `Nenhum assunto${selection.similarity !== undefined ? ` (mais próximo teve similaridade ${selection.similarity.toFixed(2)}, abaixo do mínimo)` : ""}`,
      { method: selection.method, themeId: selection.theme?.id ?? null });
    noteV2Fact("theme", { method: selection.method, themeId: selection.theme?.id ?? null, similarity: selection.similarity ?? null });
    if (selection.theme?.directHandoff) {
      // "Passar direto para o destino sem responder": transfere para o
      // destino do assunto sem chamar o modelo.
      traceStep("assunto", `"${selection.theme.name}" vai direto para o destino, sem resposta do agente`);
      noteV2Fact("handoffCause", "direct_theme", { keepFirst: true });
      llmOutput = {
        reply: "",
        handoff: true,
        concluded: false,
        confirmed: null,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Assunto com transferência direta.",
        actions: [],
      };
    } else {
      const llmResult = await callLLMWithTheme(config, context, input, resolved, themeId, collectedVariables, rule, owner, stage);
      llmOutput = llmResult.llmOutput;
      prompt = llmResult.prompt;
      inputTokens = llmResult.inputTokens;
      outputTokens = llmResult.outputTokens;
      latencyMs = llmResult.latencyMs;
      toolCalls = llmResult.toolCalls;
      governorStats = llmResult.governorStats;
      lastAgentMessage = llmResult.lastAgentMessage ?? null;
      historyLength = llmResult.historyLength ?? 0;
    }
  }

  // Guarda: se usou tools de consulta, todas voltaram vazias e não tem dados do
  // cliente, não pode inventar resposta. Aplica a saída configurada.
  if (
    llmOutput &&
    !llmOutput.handoff &&
    !llmOutput.concluded &&
    allQueryToolResultsEmpty(toolCalls) &&
    !context.contact &&
    !context.selectedDeal
  ) {
    const noSourceMessage = config.fallback?.noSource?.message?.trim();
    if (noSourceMessage) {
      llmOutput.handoff = false;
      llmOutput.reply = noSourceMessage;
      llmOutput.reason = "Consulta sem resultados e sem dados do cliente — saída 'sem material de consulta' configurada";
    } else {
      llmOutput.handoff = true;
      llmOutput.reply = config.handoff.message;
      llmOutput.reason = "Consulta sem resultados e sem dados do cliente";
      noteV2Fact("handoffCause", "no_source", { keepFirst: true });
    }
  }

  // Governor: se estourou o limite de chamadas e não tem material nem dado do
  // cliente, não pode responder de memória.
  if (
    llmOutput &&
    !llmOutput.handoff &&
    !llmOutput.concluded &&
    governorStats?.limitHit &&
    (!toolCalls?.length || allQueryToolResultsEmpty(toolCalls)) &&
    !context.contact &&
    !context.selectedDeal
  ) {
    const noSourceMessage = config.fallback?.noSource?.message?.trim();
    if (noSourceMessage) {
      llmOutput.handoff = false;
      llmOutput.reply = noSourceMessage;
      llmOutput.reason = "Limite de chamadas de ferramenta atingido sem resultados — saída 'sem material de consulta' configurada";
    } else {
      llmOutput.handoff = true;
      llmOutput.reply = config.handoff.message;
      llmOutput.reason = "Limite de chamadas de ferramenta atingido sem resultados";
      noteV2Fact("handoffCause", "no_source", { keepFirst: true });
    }
  }

  for (const call of toolCalls ?? []) {
    if ((call as { args?: { prefetch?: boolean } }).args?.prefetch) continue;
    traceStep("ferramenta", describeToolCall(call));
  }
  if (llmOutput) {
    const modelTools = (toolCalls ?? [])
      .filter((c) => !(c as { args?: { prefetch?: boolean } }).args?.prefetch)
      .map((c) => c.toolName);
    traceStep("llm", `Decisão do modelo: ${llmOutput.reason?.trim() || "(sem motivo informado)"}${
      llmOutput.handoff ? " · pediu transferência" : ""}${llmOutput.concluded ? " · encerrou" : ""}${
      modelTools.length ? ` · consultou: ${modelTools.join(", ")}` : ""}`,
      { confirmed: llmOutput.confirmed, outOfScope: llmOutput.outOfScope, tokens: inputTokens + outputTokens });
  } else {
    traceStep("llm", `O modelo não respondeu (erro: ${prompt || "desconhecido"}) → transferência`);
  }

  // Pedido novo nesta mensagem não encerra (a despedida ia no lugar da resposta).
  if (llmOutput && keepOpenOnNewRequest(config, input.userMessage, llmOutput)) {
    traceStep("encerramento", "O modelo quis encerrar, mas o cliente fez um pedido nesta mensagem → a resposta vai e o atendimento segue aberto");
  }

  if (!llmOutput) {
    noteV2Fact("handoffCause", "error", { keepFirst: true });
    // "Erro técnico" configurado na tela só valia no modo de teste.
    const fallback = config.fallback?.error?.message || config.handoff.message;
    await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, fallback, counters, themeId);
    return { handoff: true, closed: false, sentReply: fallback };
  }

  // Nenhum assunto por atalho, palavras ou sentido: vale o que o modelo
  // indicou (a Conversa de teste já fazia assim). Fica para os próximos turnos.
  if (!themeId && llmOutput.theme && config.themes.some((t) => t.id === llmOutput!.theme)) {
    themeId = llmOutput.theme;
    traceStep("assunto", `O modelo indicou o assunto "${getV2ThemeById(config, themeId)?.name ?? themeId}"`);
    noteV2Fact("theme", { method: "model", themeId, similarity: null });
  }

  // Memória: o que o LLM coletou neste turno fica para os próximos.
  Object.assign(collectedVariables, llmOutput.collected ?? {});

  // Ações permitidas. Sem assunto ativo valem as ferramentas habilitadas na
  // config (antes só handoff/close/tema/variável passavam e até o
  // `messageModel` do próprio LLM era descartado sem aviso).
  const activeTheme = getV2ThemeById(config, themeId);
  const allowedModelIds = allowedMessageModelIdsFor(config, activeTheme);
  const allowedTools = allowedActionTypes(config, activeTheme);

  // Handoff não passa pelo executor: vira sinal e roda uma vez só, depois
  // do aviso ao cliente (ver `performHandoff`).
  let wantsHandoff = llmOutput.handoff;
  let requestedDestination: V2Destination | undefined;
  const noteModelHandoff = () =>
    noteV2Fact("handoffCause", mentionsHumanRequest(config, input.userMessage) ? "human_request" : "model", { keepFirst: true });
  if (wantsHandoff) noteModelHandoff();
  const allowedActions: V2Action[] = [];
  for (const a of llmOutput.actions) {
    if (a.type === "handoff") {
      wantsHandoff = true;
      noteModelHandoff();
      const dest = (a as { destination?: V2Destination }).destination;
      if (dest && typeof dest === "object" && typeof dest.type === "string") requestedDestination = dest;
      continue;
    }
    if (!allowedTools.has(a.type) || !actionValueAllowed(config, a)) {
      discardedActions.push(a);
      continue;
    }
    // Modelo fora da lista liberada = o LLM inventou/escolheu um modelo que
    // o operador não autorizou para este agente/assunto.
    if (a.type === "send_message_model" && !allowedModelIds.includes(String((a as { modelId?: unknown }).modelId ?? ""))) {
      discardedActions.push(a);
      continue;
    }
    allowedActions.push(a);
  }

  if (discardedActions.length > 0) {
    traceStep("ações", `Descartadas (fora do permitido neste assunto/config): ${discardedActions.map((a) => a.type).join(", ")}`);
  }

  // Sentimento
  const sentiment = detectV2Sentiment(config, input.userMessage);
  if (shouldActOnSentiment(config, sentiment)) {
    // "Notificar e continuar" e "Apenas registrar" também transferiam.
    if (config.sentiment.action === "handoff") {
      wantsHandoff = true;
      noteV2Fact("handoffCause", "sentiment", { keepFirst: true });
      traceStep("sentimento", `Cliente classificado como "${sentiment}" → transferência`);
    } else {
      traceStep("sentimento", `Cliente classificado como "${sentiment}" → registrado, atendimento continua`);
    }
  }

  // Mensagens sem sentido/fora de escopo seguidas (limite `nonsenseLimit`).
  counters.nonsenseMessages = llmOutput.outOfScope ? counters.nonsenseMessages + 1 : 0;

  // A resposta do modelo não é mais trocada por trecho cru da base quando
  // "não cita o material": isso mandava ao cliente o material bruto em vez
  // da resposta. Invenção é tratada na checagem de nomes/valores/palpites.
  const guard = guardV2Output(llmOutput.reply, config.allowedDomains, {
    contact: context.contact,
    citableContact: context.citableContact ?? null,
    selectedDeal: context.selectedDeal,
    citableDeal: context.citableDeal ?? null,
  });
  let replyText = guard.text;
  if (guard.warnings.length > 0) traceStep("guarda", guard.warnings.join("; "));
  if (guard.forceHandoff) {
    wantsHandoff = true;
    noteV2Fact("handoffCause", "guard", { keepFirst: true });
  }

  // Executa ações
  const actionCtx = buildActionCtx(resolved!.userId, resolved!.agentConfigId, orgId, config, loadedContext, input, contactId, mapV2AutonomyToPrisma(config.autonomyMode), (v) => { counters.surveyPending = v; });
  actionCtx.llmOutput = llmOutput;
  // Ações que mandam mensagem ao cliente saem DEPOIS da reply (a reply
  // apresenta, a mensagem pronta/produto/modelo vem em seguida). As demais
  // (tag, campo, nota…) rodam agora.
  const OUTBOUND_ACTIONS = new Set(["send_message_model", "send_product", "send_whatsapp_template", "send_message"]);
  let outboundActions = allowedActions.filter((a) => OUTBOUND_ACTIONS.has(a.type));
  // Mensagem pronta enviada há pouco (cliente repetiu o pedido): não sai de
  // novo. Antes a introdução ("vou te enviar…") saía, o texto era barrado
  // pela trava anti-repetição e o cliente ficava sem nada.
  const requestedModelIds = outboundActions
    .filter((a) => a.type === "send_message_model" && typeof a.modelId === "string")
    .map((a) => a.modelId as string);
  if (requestedModelIds.length > 0) {
    const alreadySent = await recentlySentMessageModels(input.conversationId, requestedModelIds).catch(() => new Set<string>());
    if (alreadySent.size > 0) {
      outboundActions = outboundActions.filter((a) => !(a.type === "send_message_model" && alreadySent.has(a.modelId as string)));
      traceStep("ações", `Mensagem pronta já enviada nesta conversa há pouco — não reenviada (${[...alreadySent].join(", ")})`);
      // Resposta que só apresentava o material vira o aviso de que ele está acima.
      if (!outboundActions.some((a) => a.type === "send_message_model") && replyText.trim().split(/\s+/).length <= 30) {
        replyText = ALREADY_SENT_REPLY;
      }
    }
  }
  const actionRes = await executeV2Actions(allowedActions.filter((a) => !OUTBOUND_ACTIONS.has(a.type)), actionCtx);
  if (actionRes.results.length > 0) {
    traceStep("ações", actionRes.results
      .map((r) => `${r.action.type}${r.ok ? " ✓" : ` ✗ (${r.error ?? "erro"})`}`)
      .join(", "));
  }
  executedActions = actionRes.results;
  Object.assign(collectedVariables, variablesFromActions(actionRes.results));
  anyHandoff = wantsHandoff;
  anyClose = actionRes.anyClose || llmOutput.concluded;
  if (actionRes.themeId) themeId = actionRes.themeId;

  // ask_with_options: o executor só devolve as opções; saem com a resposta
  // como botões/lista do WhatsApp (ou numeradas no texto, onde não dá).
  const askOptions = normalizeAskOptions(actionRes.askOptions);
  let replyOptions = askOptions.map((o) => o.label);

  // Confirmação negativa
  if ((stage as V2Stage) === "confirming" && llmOutput.confirmed === false) {
    const identMsg = renderMessage(config.entry.identificationMessage ?? "Entendi. Vou precisar confirmar seus dados. Qual o e-mail ou CPF?", vars, defaultFormatter());
    await sendReply(identMsg);
    await upsertV2ConversationState({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
      stage: "identifying", themeId, versionId: versionId, identificationAttempts: 1, collectedVariables,
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

  // Limites de parada (a detecção de loop já contou este turno lá em cima;
  // aqui entra o contador de mensagens sem sentido atualizado agora).
  const stopLimits = stop.blocksReply ? stop : evaluateV2StopLimits(config, counters, input.userMessage, { countLoop: false });
  if (stopLimits.blocksReply) {
    if (stopLimits !== stop) traceStep("limites", `Limite de parada atingido: ${stopLimits.reason} → ${stopLimits.action}`);
    replyText = stopLimits.warn ? stopWarning(config, stopLimits.reason) : "";
    if (stopLimits.warn) traceStep("limites", "Aviso enviado; nas próximas mensagens iguais o agente fica em silêncio");
    if (stopLimits.action === "handoff") {
      anyHandoff = true;
      llmOutput.handoff = true;
      noteV2Fact("handoffCause", "limit", { keepFirst: true });
    } else if (stopLimits.action === "close") {
      anyClose = true;
      llmOutput.concluded = true;
    }
  }

  // Transferir e encerrar no mesmo turno: encerrar vencia, a transferência
  // não acontecia e o cliente ficava sem resposta e sem atendente.
  if (anyHandoff && anyClose) {
    traceStep("encerramento", "Transferência e encerramento no mesmo turno → transfere");
    anyClose = false;
    llmOutput.concluded = false;
  }

  // Mensagem pronta pedida e descartada: a reply seria só a introdução
  // ("segue o material") e nada chegaria. Uma pessoa envia.
  if (
    !anyHandoff &&
    discardedActions.some((a) => a.type === "send_message_model") &&
    !allowedActions.some((a) => a.type === "send_message_model")
  ) {
    traceStep("ações", "Mensagem pronta pedida não está liberada → transferência para enviar o material");
    noteV2Fact("handoffCause", "message_model_not_allowed", { keepFirst: true });
    anyHandoff = true;
  }

  // Fecho configurado ("me avise se funcionou"): o motor põe, não o modelo.
  // Não vai em transferência, encerramento, confirmação, botões nem na
  // resposta de fora do escopo (ela já diz com o que ele pode ajudar).
  // Com material a seguir (mensagem pronta/produto), vai depois dele: na
  // apresentação, "posso ajudar em algo mais?" chegava antes do tutorial.
  const materialFollows = !stopLimits.blocksReply && outboundActions.some((a) => a.type === "send_message_model" || a.type === "send_product");
  const endingAllowed = !anyHandoff && !anyClose && askOptions.length === 0 && (stage as V2Stage) !== "confirming" && !llmOutput.outOfScope;
  if (endingAllowed && !materialFollows && replyText.trim()) {
    const ending = applyReplyEnding({
      reply: replyText,
      ending: effectiveReplyEnding(config, activeTheme),
      lastAgentMessage,
      turnSeed: historyLength,
    });
    if (ending.added) {
      replyText = ending.text;
      traceStep("resposta", `Fecho acrescentado (${ending.kind === "procedure" ? "passo a passo" : "informação"}): "${ending.added}"`);
      replyOptions = replyEndingButtons(effectiveReplyEnding(config, activeTheme), ending.kind);
    }
  }
  // Aviso de limite no lugar da resposta: sem opções.
  if (stopLimits.blocksReply) replyOptions = [];

  // Envia reply se houver e não for handoff/close
  if (!anyHandoff && !anyClose && replyText.trim()) {
    const withOptions = replyOptions.length > 0 ? buildV2Interactive(replyText, replyOptions) : null;
    const outText = withOptions ? withOptions.fallbackText : replyText;
    const res = await sendReply(outText, withOptions?.payload);
    noteV2Fact("send", { sent: res.sent, reason: res.sent ? null : (res.reason ?? "unknown") });
    if (res.sent) {
      sentReply = outText;
      if (withOptions && withOptions.labels.length > 0) {
        counters.pendingOptions = withOptions.labels;
        traceStep("opções", `${withOptions.payload ? (withOptions.payload.kind === "buttons" ? "Botões" : "Lista") : "Opções numeradas"}: ${withOptions.labels.join(" | ")}`);
      }
    } else if (res.reason === "near_duplicate") {
      // A trava anti-repetição do envio olha as últimas mensagens do agente;
      // a do motor, só a anterior. Barrada, o cliente ficava sem nada.
      const fallback = repeatFallback(lastAgentMessage);
      const alt = await sendReply(fallback);
      if (alt.sent) sentReply = fallback;
    }
    // Não enviada fica fora do log do turno: antes o log dizia que o agente
    // respondeu e o cliente não tinha recebido nada.
  }

  // Mensagens prontas/produtos/modelos: depois da reply. Não saem quando o
  // turno transfere ou quando um limite de parada bloqueou a resposta.
  if (outboundActions.length > 0 && !anyHandoff && !stopLimits.blocksReply) {
    const outRes = await executeV2Actions(outboundActions, actionCtx);
    traceStep("ações", outRes.results
      .map((r) => `${r.action.type}${r.ok ? " ✓" : ` ✗ (${r.error ?? "erro"})`}`)
      .join(", "));
    executedActions = [...executedActions, ...outRes.results];
    // A reply já anunciou o material; se ele não saiu, uma pessoa envia.
    // Barrado só por repetir uma mensagem recente: o cliente já tem o material.
    if (outRes.results.some((r) => !r.ok && r.action.type === "send_message_model" && r.error !== MESSAGE_MODEL_REPEATED)) {
      traceStep("ações", "A mensagem pronta anunciada não foi enviada → transferência");
      noteV2Fact("handoffCause", "message_model_failed", { keepFirst: true });
      anyHandoff = true;
      anyClose = false;
    }

    // Fecho depois do material, em mensagem própria (com os botões, se houver).
    const material = outRes.results
      .filter((r) => r.ok && typeof r.text === "string")
      .map((r) => r.text as string)
      .join("\n\n");
    if (endingAllowed && materialFollows && !anyHandoff && material.trim()) {
      const ending = applyReplyEnding({
        reply: material,
        ending: effectiveReplyEnding(config, activeTheme),
        lastAgentMessage: replyText,
        turnSeed: historyLength,
      });
      if (ending.added) {
        const buttons = replyEndingButtons(effectiveReplyEnding(config, activeTheme), ending.kind);
        const built = buttons.length > 0 ? buildV2Interactive(ending.added, buttons) : null;
        const text = built ? built.fallbackText : ending.added;
        if ((await sendReply(text, built?.payload)).sent) {
          sentReply = [sentReply, text].filter(Boolean).join("\n\n");
          if (built && built.labels.length > 0) counters.pendingOptions = built.labels;
          traceStep("resposta", `Fecho enviado depois do material: "${ending.added}"`);
        }
      }
    }
  }

  // Handoff: aviso + transferência, uma vez. Destino: o pedido na ação >
  // o do assunto ativo > o padrão da config.
  if (anyHandoff && !anyClose) {
    // Citava algo sem fonte: vale a mensagem "sem material" configurada (o
    // modelo já a montou), não a de transferência padrão.
    const noSourceMsg = peekV2Fact("handoffCause") === "verification" ? config.fallback?.noSource?.message?.trim() : "";
    const sent = await performHandoff(requestedDestination ?? activeTheme?.handoffDestination, noSourceMsg ? { message: noSourceMsg } : {});
    if (sent) sentReply = sentReply ? `${sentReply}\n${sent}`.trim() : sent;
    owner = "pessoa";
  }

  // Encerramento
  if (anyClose) {
    const goodbye = config.closure.goodbyeMessage;
    if (goodbye && !anyHandoff) {
      const goodbyeRendered = renderMessage(goodbye, vars, defaultFormatter());
      if ((await sendReply(goodbyeRendered)).sent) sentReply = goodbyeRendered;
    }
    await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, llmOutput.concluded ? "resolved" : "transferred", loadedContext.contactId, collectedVariables);
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
      collectedVariables,
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

  /**
   * Único caminho de handoff do turno: avisa o cliente, depois transfere
   * (uma vez só). A ordem importa: `sendV2TextMessage` exige que a IA ainda
   * seja a responsável, então transferir antes descartava o aviso. Antes o
   * handoff vindo como ação do LLM/sentimento rodava no executor E de novo
   * aqui — duas distribuições seguidas, possivelmente para atendentes
   * diferentes.
   */
  async function performHandoff(
    requested: V2Destination | undefined,
    opts: { skipMessage?: boolean; message?: string } = {},
  ): Promise<string | undefined> {
    let sent: string | undefined;
    if (!opts.skipMessage) {
      // Mensagem do destino (assunto/regra) quando configurada; a tela já
      // tinha o campo, mas valia sempre a mensagem padrão.
      const destinationMessage = typeof requested?.message === "string" ? requested.message.trim() : "";
      const handoffMsg = renderMessage(opts.message || destinationMessage || config.handoff.message, vars, defaultFormatter());
      if (handoffMsg.trim() && (await sendReply(handoffMsg)).sent) {
        sent = handoffMsg;
      }
    }
    const destination = resolveHandoffDestination(config, requested ?? config.handoff.defaultDestination, counters);
    if (destination.type === "ai_agent") counters.aiTransferCount += 1;
    await simpleHandoff({
      conversationId: input.conversationId,
      contactId,
      dealId: loadedContext.dealId,
      destination,
    });
    traceStep("transferência", `Transferido para ${destination.type}${destination.id ? ` (${destination.id})` : ""}`);
    return sent;
  }

  async function sendReply(text: string, interactive?: V2InteractivePayload | null): Promise<{ sent: boolean; reason?: string }> {
    if (!text.trim()) return { sent: false, reason: "empty" };
    return sendV2TextMessage({
      interactive,
      conversationId: input.conversationId,
      contactId: contactId!,
      agentUserId: resolved!.userId,
      text,
      channel: input.channel,
      autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
      humanBehavior,
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
  /** Última mensagem do agente na conversa (o fecho não se repete). */
  lastAgentMessage?: string | null;
  historyLength?: number;
}> {
  const theme = getV2ThemeById(config, themeId);
  const themeInstructions = theme
    ? themePromptText(theme)
    : undefined;

  const previousMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  // Carrega últimas mensagens do histórico
  try {
    const rows = await (prisma as unknown as {
      message: {
        findMany: (args: { where: Record<string, unknown>; orderBy: { createdAt: "desc" }; take: number; select: { id: boolean; direction: boolean; content: boolean; authorType: boolean; messageType: boolean; organizationId: boolean } }) => Promise<Array<{ id: string; direction: string; content: string; authorType: string; messageType: string; organizationId: string }>>;
      };
    }).message.findMany({
      where: { conversationId: input.conversationId, messageType: { not: "note" }, isPrivate: false },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, direction: true, content: true, authorType: true, messageType: true, organizationId: true },
    });
    // Áudio/imagem já entendidos entram com o conteúdo, não com "[Áudio]".
    const mediaRows = rows.filter((m) => m.direction === "in" && understoodKindOf(m.messageType));
    const mediaTexts = mediaRows.length > 0 ? await getMediaTexts(mediaRows[0].organizationId, mediaRows.map((m) => m.id)) : new Map<string, string>();
    for (const m of rows.reverse()) {
      const role = m.direction === "out" || m.authorType === "bot" ? "assistant" : "user";
      const kind = understoodKindOf(m.messageType);
      const understood = kind ? mediaTexts.get(m.id) : undefined;
      previousMessages.push({ role, content: understood && kind ? mediaTextLine(kind, understood, m.content) : m.content ?? "" });
    }
    // Tira do histórico só as bolhas do turno atual (já vão agregadas em
    // `userMessage`). Mensagem do cliente que ficou sem resposta num turno
    // anterior NÃO é do turno atual e precisa continuar visível.
    while (previousMessages.length > 0) {
      const last = previousMessages[previousMessages.length - 1];
      if (last.role !== "user") break;
      const text = last.content.trim();
      if (text && !input.userMessage.includes(text)) break;
      previousMessages.pop();
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
      lastAgentMessage: [...previousMessages].reverse().find((m) => m.role === "assistant")?.content ?? null,
      historyLength: previousMessages.length,
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
  counters: V2Counters,
  themeId?: string,
): Promise<void> {
  await sendV2TextMessage({
    conversationId: input.conversationId,
    contactId,
    agentUserId: resolved!.userId,
    text: message,
    channel: input.channel,
    autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
    humanBehavior: v2HumanBehavior(config),
  });
  const fallbackDestination = resolveHandoffDestination(config, config.handoff.defaultDestination, counters);
  if (fallbackDestination.type === "ai_agent") counters.aiTransferCount += 1;
  traceStep("transferência", `Transferido para ${fallbackDestination.type}${fallbackDestination.id ? ` (${fallbackDestination.id})` : ""}`);
  await simpleHandoff({
    conversationId: input.conversationId,
    contactId,
    dealId: loadedContext.dealId,
    destination: fallbackDestination,
  });
  await upsertV2ConversationState({
    organizationId: orgId,
    conversationId: input.conversationId,
    agentId: resolved!.agentConfigId,
    owner: "pessoa",
    counters: counters as V2Counters,
    versionId,
    ...(themeId ? { themeId } : {}),
  });
  await logV2Turn({
    organizationId: orgId,
    conversationId: input.conversationId,
    agentId: resolved!.agentConfigId,
    turnId: input.turnId,
    inboundText: input.userMessage,
    // contactRaw vai junto: é dele que o log tira nome e telefone para mascarar.
    crmContext: {
      contact: loadedContext.contact,
      contactRaw: loadedContext.contactRaw,
      deals: loadedContext.deals,
      selectedDeal: loadedContext.selectedDeal,
      fields: config.contextFields,
    },
    themeId,
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

/** Cria o negócio inicial no funil padrão (ou no mais antigo). null = não deu. */
async function createInitialDeal(contactId: string): Promise<string | null> {
  const pipelines = prisma as unknown as {
    pipeline: {
      findFirst: (args: { where: Record<string, unknown>; orderBy: { createdAt: "asc" } }) => Promise<{ id: string } | null>;
    };
  };
  const firstPipeline =
    (await pipelines.pipeline.findFirst({ where: { isDefault: true }, orderBy: { createdAt: "asc" } })) ??
    (await pipelines.pipeline.findFirst({ where: {}, orderBy: { createdAt: "asc" } }));
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
  if (!stage) return null;
  try {
    const deal = await createDeal({
      title: "Novo atendimento",
      contactId,
      stageId: stage.id,
      status: "OPEN",
    } as any);
    return (deal as { id?: string } | null)?.id ?? null;
  } catch (err) {
    console.error("[ai-v2] createInitialDeal falhou", err);
    return null;
  }
}

async function closeState(
  orgId: string,
  conversationId: string,
  agentConfigId: string,
  dealId: string | undefined,
  config: V2AgentConfig,
  versionId: string | undefined,
  reason: string,
  contactId?: string,
  collectedVariables?: Record<string, unknown>,
): Promise<void> {
  if (config.closure.fieldUpdates && config.closure.fieldUpdates.length > 0) {
    await applyV2ClosureFieldUpdates(config, contactId, dealId);
  }
  if (config.closure.nextAutomationStepId && contactId) {
    await continueV2AutomationOnClose({ config, contactId, collectedVariables: collectedVariables ?? {} });
  }
  const windowHours = config.closure.postCloseWindowHours;
  const postCloseWindowEndAt = new Date(Date.now() + windowHours * 60 * 60 * 1000);
  // Mesmo caminho do encerramento pelo inbox: status + closedAt, restauração
  // do negócio, eventos e automações. Antes era um update só de status —
  // sem closedAt a conversa continuava contando como aberta no inbox.
  // keepAgent: o agente segue dono durante a janela pós-encerramento.
  const { resolveConversationsInline } = await import("@/services/conversations");
  await resolveConversationsInline({
    ids: [conversationId],
    keepAgent: true,
    keepDepartment: true,
    tabulation: null,
  });
  await upsertV2ConversationState({
    organizationId: orgId,
    conversationId,
    agentId: agentConfigId,
    stage: "closed",
    owner: "ninguem",
    postCloseWindowEndAt,
    closeReason: reason,
    versionId,
    collectedVariables: collectedVariables ?? {},
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
  setSurveyPending?: (pending: boolean) => void,
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
    setSurveyPending,
    userMessage: input.userMessage,
  };
}
