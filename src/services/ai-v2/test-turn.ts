/**
 * Simulação de turno v2 para a aba Testar (e o comparador).
 * Não persiste estado nem executa ações reais, mas decide como a produção:
 * mesma escolha de assunto, regras terminais, política de ações, guarda de
 * fonte e o que o cliente receberia ao transferir.
 */

import type { V2Action, V2AgentConfig, V2CRMContext, V2Rule, V2Stage } from "@/lib/ai-v2/types";
import { evaluateV2Rules, isWithinV2BusinessHours } from "./rules";
import { getV2ThemeById } from "./themes";
import { selectV2ThemeSemantic } from "./theme-semantic";
import { allowedActionTypes, allowedMessageModelIdsFor, normalizeAskOptions } from "./action-policy";
import { detectV2Sentiment, shouldActOnSentiment } from "./sentiment";
import { callV2LLMTest } from "./llm";
import { guardV2Output } from "./output-guard";
import { loadV2Context, buildAskDealMessage } from "./context";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { applyConfirmationIdentity, confirmationIdentityValues, renderMessage, defaultFormatter, buildVariableMap } from "@/lib/ai-v2/message-render";
import { answerFromKnowledge } from "./ground-reply";
import { getRequestContext, enterRequestContext } from "@/lib/request-context";

export type V2TestTurnHistoryItem = { role: "user" | "assistant"; content: string };

export type V2TestTurnResult = {
  userMessage: string;
  appliedRuleId: string | null;
  appliedRuleName: string | null;
  themeId: string | null;
  themeName: string | null;
  reply: string;
  reason: string;
  handoff: boolean;
  closed: boolean;
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
  ragChunks: Array<{ docId?: string; docTitle?: string; text?: string; score?: number }>;
  executedActions: Array<{ action: V2Action; label: string }>;
  discardedActions: Array<{ action: V2Action; label: string; reason: string }>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  tone: string;
  responseLength: string;
  globalRules: string[];
  systemPrompt: string;
  expandedByLength?: boolean;
  crmContext: V2CRMContext;
  dealSelectionReason: string;
  scrubbedFields?: string[];
  /** Estágio da conversa após este turno (para simulação multi-turno). */
  stage?: V2Stage;
};

const ACTION_LABELS: Record<string, string> = {
  add_tag: "Adicionar etiqueta",
  update_field: "Atualizar campo",
  add_note: "Registrar anotação",
  create_deal: "Criar negócio",
  move_stage: "Mover etapa do negócio",
  create_activity: "Criar atividade",
  send_message_model: "Enviar mensagem pronta",
  send_product: "Enviar produto",
  send_whatsapp_template: "Enviar template oficial",
  ask_with_options: "Perguntar com opções",
  close_conversation: "Encerrar conversa",
  tabulate_conversation: "Classificar atendimento",
  handoff: "Passar para uma pessoa",
  set_theme: "Definir assunto",
  set_variable: "Definir variável",
  record_knowledge_gap: "Registrar dúvida sem resposta",
  start_survey: "Iniciar pesquisa de satisfação",
  send_message: "Enviar mensagem",
};

function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? type;
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

function renderConfirmationText(config: V2AgentConfig, context: V2CRMContext, vars: Record<string, unknown>): string {
  const rendered = renderMessage(
    config.entry.confirmationMessage ?? "Confirmo que estou falando com você. Como posso ajudar?",
    vars,
    defaultFormatter(),
  );
  return applyConfirmationIdentity(rendered, confirmationIdentityValues({
    fieldKeys: config.entry.confirmationFields ?? [],
    fieldLabels: [...config.contextFields.contact, ...config.contextFields.deal],
    sources: [context.contactRaw, context.selectedDealRaw, context.contact, context.selectedDeal],
  }));
}

export async function simulateV2Turn(
  agentId: string,
  config: V2AgentConfig,
  userMessage: string,
  history: V2TestTurnHistoryItem[] = [],
  organizationId?: string,
  contactId?: string,
  selectedDealId?: string,
  stage: V2Stage = "active",
  /** Assunto do turno anterior, para manter o assunto como em produção. */
  currentThemeId?: string | null,
): Promise<V2TestTurnResult> {
  // Garante contexto de tenant para as tools do motor no ambiente de teste.
  if (organizationId && !getRequestContext()) {
    enterRequestContext({
      organizationId,
      userId: "test-simulation",
      isSuperAdmin: false,
      actor: { type: "AI", label: "Agente v2 (teste)", ref: agentId },
    });
  }

  let context: V2CRMContext;
  if (organizationId) {
    context = await loadV2Context({
      organizationId,
      config,
      contactId,
      selectedDealId,
    });
  } else {
    context = { contact: null, deals: [], selectedDeal: null, fields: config.contextFields };
  }

  // Fluxo de entrada na primeira mensagem da simulação.
  // Reproduz boas-vindas + confirmação/identificação antes de chamar o modelo.
  const effectiveStage: V2Stage = history.length === 0 ? "idle" : stage;
  if (effectiveStage === "idle") {
    const vars = buildVariableMap(config.variables, context.contact, context.selectedDeal, context.contactRaw, context.selectedDealRaw);
    if (!context.selectedDeal) {
      if (config.entry.onDealNotFound === "ask_identification") {
        const parts: string[] = [];
        if (config.entry.openingEnabled && config.entry.openingMessage) {
          parts.push(renderMessage(config.entry.openingMessage, vars, defaultFormatter()));
        }
        parts.push(renderMessage(config.entry.identificationMessage ?? "Preciso confirmar seus dados. Qual o seu e-mail ou CPF?", vars, defaultFormatter()));
        const identReply = parts.filter(Boolean).join("\n\n");
        return {
          userMessage,
          appliedRuleId: null,
          appliedRuleName: null,
          themeId: null,
          themeName: null,
          reply: identReply,
          reason: "Primeira mensagem: fluxo de entrada (identificação).",
          handoff: false,
          closed: false,
          toolCalls: [],
          ragChunks: [],
          executedActions: [],
          discardedActions: [],
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          tone: config.tone ?? "",
          responseLength: config.responseLength ?? "medium",
          globalRules: config.globalRules,
          systemPrompt: "",
          crmContext: context,
          dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
          stage: "identifying",
        };
      }
    } else if (config.entry.confirmContact) {
      const mode = config.entry.confirmationMode ?? "combined";
      if (mode === "separate_turn") {
        const welcomeMsg = config.entry.openingEnabled && config.entry.openingMessage
          ? renderMessage(config.entry.openingMessage, vars, defaultFormatter())
          : "";
        return {
          userMessage,
          appliedRuleId: null,
          appliedRuleName: null,
          themeId: null,
          themeName: null,
          reply: welcomeMsg,
          reason: "Primeira mensagem: boas-vindas. A confirmação será perguntada no próximo turno.",
          handoff: false,
          closed: false,
          toolCalls: [],
          ragChunks: [],
          executedActions: [],
          discardedActions: [],
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          tone: config.tone ?? "",
          responseLength: config.responseLength ?? "medium",
          globalRules: config.globalRules,
          systemPrompt: "",
          crmContext: context,
          dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
          stage: "confirming",
        };
      }

      const parts: string[] = [];
      if (config.entry.openingEnabled && config.entry.openingMessage) {
        parts.push(renderMessage(config.entry.openingMessage, vars, defaultFormatter()));
      }
      parts.push(renderConfirmationText(config, context, vars));
      const entryReply = parts.filter(Boolean).join("\n\n");
      return {
        userMessage,
        appliedRuleId: null,
        appliedRuleName: null,
        themeId: null,
        themeName: null,
        reply: entryReply,
        reason: "Primeira mensagem: fluxo de entrada (boas-vindas / confirmação).",
        handoff: false,
        closed: false,
        toolCalls: [],
        ragChunks: [],
        executedActions: [],
        discardedActions: [],
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        tone: config.tone ?? "",
        responseLength: config.responseLength ?? "medium",
        globalRules: config.globalRules,
        systemPrompt: "",
        crmContext: context,
        dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
        stage: "confirming",
      };
    }
  }

  // Turno seguinte às boas-vindas no modo separate_turn: envia a confirmação.
  if (effectiveStage === "confirming" && config.entry.confirmContact && (config.entry.confirmationMode ?? "combined") === "separate_turn") {
    const vars = buildVariableMap(config.variables, context.contact, context.selectedDeal, context.contactRaw, context.selectedDealRaw);
    const confirmMsg = renderConfirmationText(config, context, vars);
    return {
      userMessage,
      appliedRuleId: null,
      appliedRuleName: null,
      themeId: null,
      themeName: null,
      reply: confirmMsg,
      reason: "Confirmação de identidade no turno seguinte.",
      handoff: false,
      closed: false,
      toolCalls: [],
      ragChunks: [],
      executedActions: [],
      discardedActions: [],
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      tone: config.tone ?? "",
      responseLength: config.responseLength ?? "medium",
      globalRules: config.globalRules,
      systemPrompt: "",
      crmContext: context,
      dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
      stage: "confirming",
    };
  }

  // Se há vários negócios abertos e o operador configurou "perguntar",
  // o teste mostra a pergunta sem gastar chamada de modelo.
  if (config.dealSelection === "ask" && context.deals && context.deals.length > 1 && !context.selectedDeal) {
    const askMessage = buildAskDealMessage(context.deals, config);
    return {
      userMessage,
      appliedRuleId: null,
      appliedRuleName: null,
      themeId: null,
      themeName: null,
      reply: askMessage,
      reason: "Vários negócios abertos — perguntando qual tratar.",
      handoff: false,
      closed: false,
      toolCalls: [],
      ragChunks: [],
      executedActions: [],
      discardedActions: [],
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      tone: config.tone ?? "",
      responseLength: config.responseLength ?? "medium",
      globalRules: config.globalRules,
      systemPrompt: "",
      crmContext: context,
      dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
      stage: "active",
    };
  }

  const apiKey = await tryGetAgentApiKey(agentId);
  if (!apiKey) {
    throw new Error("NO_OPENAI_KEY");
  }

  const rule = evaluateV2Rules(
    config,
    {
      userMessage,
      isFirstMessage: history.length === 0,
      withinBusinessHours: isWithinV2BusinessHours(config),
      contactTags: [],
      mediaKinds: ["text"],
    },
    context,
  );
  const appliedRuleId = rule?.id ?? null;
  const vars = buildVariableMap(config.variables, context.contact, context.selectedDeal, context.contactRaw, context.selectedDealRaw);

  const quickResult = (partial: Partial<V2TestTurnResult> & { reply: string; reason: string }): V2TestTurnResult => ({
    userMessage,
    appliedRuleId,
    appliedRuleName: rule?.name ?? null,
    themeId: null,
    themeName: null,
    handoff: false,
    closed: false,
    toolCalls: [],
    ragChunks: [],
    executedActions: [],
    discardedActions: [],
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    tone: config.tone ?? "",
    responseLength: config.responseLength ?? "medium",
    globalRules: config.globalRules,
    systemPrompt: "",
    crmContext: context,
    dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
    stage: "active",
    ...partial,
  });

  // Regra com ação terminal: em produção o turno acaba ali, sem modelo.
  // Antes o teste seguia para o modelo e mostrava outra resposta.
  const ruleTurn = rule ? simulateTerminalRule(config, rule, vars) : null;
  if (ruleTurn) {
    return quickResult({
      reply: ruleTurn.reply,
      reason: `Regra "${rule!.name}" respondeu sem chamar o modelo.`,
      handoff: ruleTurn.handoff,
      closed: ruleTurn.closed,
      executedActions: ruleTurn.executed,
    });
  }

  // Tema escolhido pela regra ou, como em produção: gatilho > significado >
  // assunto atual da conversa. Antes o teste usava só gatilhos e não
  // lembrava o assunto entre mensagens.
  let themeId: string | null = null;
  if (rule?.actions.some((a) => a.type === "set_theme" && a.themeId)) {
    themeId = rule.actions.find((a) => a.type === "set_theme")?.themeId ?? null;
  }
  if (!themeId) {
    const selection = await selectV2ThemeSemantic({
      config,
      message: userMessage,
      currentThemeId: currentThemeId ?? undefined,
      apiKey,
    });
    themeId = selection.theme?.id ?? currentThemeId ?? null;
  }
  const selectedTheme = getV2ThemeById(config, themeId ?? undefined);
  if (selectedTheme?.directHandoff) {
    return quickResult({
      reply: config.handoff.message,
      reason: `Assunto "${selectedTheme.name}" vai direto para o destino, sem resposta do agente.`,
      handoff: true,
      themeId: selectedTheme.id,
      themeName: selectedTheme.name,
    });
  }

  let llmResult: Awaited<ReturnType<typeof callV2LLMTest>>;
  try {
    llmResult = await callV2LLMTest(agentId, config, userMessage, history, context, themeId, effectiveStage === "idle" ? "active" : effectiveStage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[simulateV2Turn] LLM failed:", msg);
    llmResult = {
      output: {
        reply: config.fallback?.error?.message?.trim() || config.handoff.message,
        handoff: true,
        concluded: false,
        confirmed: null,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: `Falha na chamada LLM: ${msg}`,
        actions: [{ type: "handoff" }],
      },
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      governorStats: { totalCalls: 0, replays: 0, denials: 0, limitHit: false },
      toolCalls: [],
      wasExpanded: false,
      systemPrompt: "",
    };
  }
  let output = llmResult.output;

  // Guarda de fonte, igual à produção: consulta sem resultado e sem dados do
  // cliente usa a saída configurada; sem ela, transfere.
  const noClientData = !context.contact && !context.selectedDeal;
  const emptyQueries = allQueryToolResultsEmpty(llmResult.toolCalls);
  const governorBlind = llmResult.governorStats?.limitHit && (!llmResult.toolCalls?.length || emptyQueries);
  if (!output.handoff && !output.concluded && noClientData && (emptyQueries || governorBlind)) {
    const noSourceMessage = config.fallback?.noSource?.message?.trim();
    output = noSourceMessage
      ? { ...output, handoff: false, reply: noSourceMessage, reason: "Consulta sem resultados e sem dados do cliente — saída 'sem material de consulta' configurada" }
      : { ...output, handoff: true, reply: config.handoff.message, reason: "Consulta sem resultados e sem dados do cliente" };
  }

  // Aterramento antes da guarda, como em produção: o trecho da base também
  // passa pelo filtro de domínios e de campos internos.
  const grounded = await answerFromKnowledge({
    reply: output.reply,
    toolCalls: llmResult.toolCalls,
    config,
    themeId: themeId ?? undefined,
    userMessage,
    agentId,
  });
  const guard = guardV2Output(grounded, config.allowedDomains, {
    contact: context.contact,
    citableContact: context.citableContact ?? null,
    selectedDeal: context.selectedDeal,
    citableDeal: context.citableDeal ?? null,
  });
  output = { ...output, reply: guard.text };
  let handoff = output.handoff || !!guard.forceHandoff;
  let closed = output.concluded;

  // O assunto escolhido pelas frases vale. O tema do modelo só entra se nenhum casou.
  if (!themeId && output.theme) {
    themeId = output.theme;
  }

  // Mesma política de ações da produção (action-policy).
  const activeTheme = getV2ThemeById(config, themeId ?? undefined);
  const allowedTools = allowedActionTypes(config, activeTheme);
  const allowedModelIds = allowedMessageModelIdsFor(config, activeTheme);
  const executedActions: V2TestTurnResult["executedActions"] = [];
  const discardedActions: V2TestTurnResult["discardedActions"] = [];
  for (const action of output.actions) {
    if (action.type === "handoff") {
      handoff = true;
      executedActions.push({ action, label: actionLabel(action.type) });
      continue;
    }
    const modelNotAllowed = action.type === "send_message_model" && !allowedModelIds.includes(String((action as { modelId?: unknown }).modelId ?? ""));
    if (allowedTools.has(action.type) && !modelNotAllowed) {
      executedActions.push({ action, label: actionLabel(action.type) });
    } else {
      discardedActions.push({
        action,
        label: actionLabel(action.type),
        reason: modelNotAllowed
          ? "Esta mensagem pronta não está liberada para o agente/assunto."
          : "A configuração do agente não libera esta ação.",
      });
    }
  }
  if (output.actions.some((a) => a.type === "close_conversation") && allowedTools.has("close_conversation")) closed = true;

  // Sentimento, igual à produção.
  if (shouldActOnSentiment(config, detectV2Sentiment(config, userMessage)) && config.sentiment.action === "handoff") {
    handoff = true;
  }
  // Mensagem pronta anunciada e não liberada: produção transfere.
  if (
    discardedActions.some((d) => d.action.type === "send_message_model") &&
    !executedActions.some((e) => e.action.type === "send_message_model")
  ) {
    handoff = true;
  }
  if (handoff && closed) closed = false;

  // Em produção, ao transferir o cliente recebe a mensagem de transferência,
  // não a resposta do modelo; ao encerrar, a despedida (quando configurada).
  let reply = output.reply;
  if (handoff) {
    reply = renderMessage(config.handoff.message, vars, defaultFormatter());
  } else if (closed && config.closure.goodbyeMessage) {
    reply = renderMessage(config.closure.goodbyeMessage, vars, defaultFormatter());
  } else {
    const askAction = executedActions.find((e) => e.action.type === "ask_with_options");
    const options = normalizeAskOptions((askAction?.action as { options?: unknown[] } | undefined)?.options);
    if (options.length > 0) {
      reply = [reply.trim(), options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")].filter(Boolean).join("\n\n");
    }
  }

  // Confirmação negativa: produção volta a pedir identificação.
  let nextStage: V2Stage = "active";
  if (effectiveStage === "confirming" && output.confirmed === false && !handoff) {
    reply = renderMessage(config.entry.identificationMessage ?? "Entendi. Vou precisar confirmar seus dados. Qual o e-mail ou CPF?", vars, defaultFormatter());
    nextStage = "identifying";
  }

  // Extrai chunks do RAG dos toolCalls.
  const ragChunks: V2TestTurnResult["ragChunks"] = [];
  for (const call of llmResult.toolCalls ?? []) {
    const result = call.result as Record<string, unknown> | undefined;
    if (call.toolName === "knowledge_search" && result && Array.isArray(result.chunks)) {
      for (const chunk of result.chunks as Array<Record<string, unknown>>) {
        ragChunks.push({
          docId: typeof chunk.docId === "string" ? chunk.docId : undefined,
          docTitle: typeof chunk.docTitle === "string" ? chunk.docTitle : undefined,
          text: typeof chunk.content === "string" ? chunk.content : undefined,
          score: typeof chunk.distance === "number" ? chunk.distance : undefined,
        });
      }
    }
  }

  return {
    userMessage,
    appliedRuleId,
    appliedRuleName: rule?.name ?? null,
    themeId,
    themeName: activeTheme?.name ?? null,
    reply,
    reason: output.reason,
    handoff,
    closed,
    toolCalls: llmResult.toolCalls ?? [],
    ragChunks,
    executedActions,
    discardedActions,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    latencyMs: llmResult.latencyMs,
    tone: config.tone ?? "",
    responseLength: config.responseLength ?? "medium",
    globalRules: config.globalRules,
    systemPrompt: llmResult.systemPrompt,
    expandedByLength: llmResult.wasExpanded,
    crmContext: context,
    dealSelectionReason: context.dealSelectionReason ?? "Nenhum negócio carregado.",
    scrubbedFields: guard.scrubbedFields,
    stage: nextStage,
  };
}

/**
 * Ações terminais da regra, simuladas. Como em produção, só encerram o
 * turno quando dariam certo: ação salva sem o parâmetro segue para o modelo.
 */
function simulateTerminalRule(
  config: V2AgentConfig,
  rule: V2Rule,
  vars: Record<string, unknown>,
): { reply: string; handoff: boolean; closed: boolean; executed: V2TestTurnResult["executedActions"] } | null {
  const executed: V2TestTurnResult["executedActions"] = [];
  const replies: string[] = [];
  let handoff = false;
  let closed = false;
  let terminal = false;
  for (const a of rule.actions) {
    const action = a as unknown as V2Action;
    if (a.type === "send_message" && a.message?.trim()) {
      replies.push(renderMessage(a.message, vars, defaultFormatter()));
    } else if ((a.type === "send_message_model" || a.type === "send_whatsapp_template") && a.modelId) {
      replies.push(`(${actionLabel(a.type)}: ${a.modelId})`);
    } else if (a.type === "handoff") {
      handoff = true;
    } else if (a.type === "close_conversation") {
      closed = true;
    } else if (a.type !== "no_reply") {
      continue;
    }
    terminal = true;
    executed.push({ action, label: actionLabel(a.type) });
  }
  if (!terminal) return null;
  if (handoff && replies.length === 0) replies.push(renderMessage(config.handoff.message, vars, defaultFormatter()));
  return { reply: replies.join("\n\n"), handoff, closed: closed && !handoff, executed };
}
