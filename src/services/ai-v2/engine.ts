/**
 * Motor v2 de processamento de turno.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import type { V2Action, V2AgentConfig, V2CRMContext, V2Destination, V2LLMOutput, V2Owner, V2Stage, V2Theme } from "@/lib/ai-v2/types";
import type { V2ActionResult } from "./actions";
import { applyConfirmationIdentity, buildVariableMap, confirmationIdentityValues, defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import { fieldMasks } from "@/lib/ai-v2/field-mask";
import { createDeal } from "@/services/deals";
import { resolveV2AgentForConversation } from "./agent-resolver";
import { loadV2Context, buildAskDealMessage, describeV2ContextForTrace, tryParseDealChoice, type V2LoadedContext } from "./context";
import { detectV2Sentiment, shouldActOnSentiment } from "./sentiment";
import { evaluateV2Rules, isWithinV2BusinessHours, outsideHoursNote } from "./rules";
import { getV2ThemeById } from "./themes";
import { agentAskedQuestion, selectV2ThemeSemantic, type V2ThemeSelection } from "./theme-semantic";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { detectV2MediaKinds, evaluateV2Media } from "./media";
import { enrichTurnWithMedia } from "./media-turn";
import { isMediaPlaceholderText } from "@/lib/ai-agents/media-placeholder";
import { getMediaTexts, mediaTextLine, understoodKindOf } from "./media-understanding";
import { callV2LLM } from "./llm";
import { themePromptText } from "./theme-prompt";
import { actionValueAllowed, allowedActionTypes, allowedFlowIdsFor, allowedMessageModelIdsFor, humanRequestSubject, mentionsHumanRequest, normalizeAskOptions } from "./action-policy";

export { mentionsHumanRequest };
import { guardV2Output } from "./output-guard";
import { messageModelFilesOnly, messageModelModeFor } from "@/lib/ai-v2/message-model-mode";
import { customSystemMessage, systemMessage } from "@/lib/ai-v2/system-messages";
import { isDeferralText, isShortAckText } from "@/lib/ai-agents/tabulation-classify-policy";
import { isCourtesyOnlyInbound } from "@/services/post-close-return";
import { executeV2Actions, sendV2TextMessage, applyV2ClosureFieldUpdates, v2HumanBehavior } from "./actions";
import { findInheritablePostCloseState, getV2ConversationState, upsertV2ConversationState } from "./state";
import { logV2Turn } from "./log";
import { noteV2Fact, peekV2Fact, runWithV2Trace, traceStep, v2TraceWasLogged } from "./trace";
import { evaluateV2StopLimits, parseV2Counters, shouldStopStalled, type V2Counters } from "./limits";
import { answerToPostCloseQuestion, classifyPostCloseMessage, getPostCloseBehavior, isGreetingOnlyMessage, keepOpenOnNewRequest, postCloseHandoffMessage, postCloseQuestion, postCloseShortReply, isExplicitResolution } from "./closure";
import { isConfusionMessage, rephraseAfterConfusion } from "./confusion";
import { applyNoSourceGuard, conditionalHandoff, handoffExplanation, type V2PrefetchFact } from "./no-source";
import { NONSENSE_LIMIT_REASON } from "./limits";
import { applyV2Tabulation } from "./tabulation";
import { applyReplyEnding, asksClient, classifyReply, effectiveReplyEnding, isGreetingOnlyReply, replyEndingButtons, replyEndingPhrases, withoutReplyEndings } from "./reply-ending";
import { hasSearchableQuestion, knowledgeChunkTexts, repeatFallback } from "./ground-reply";
import { loadPriorV2Summary, summaryEnabled, updateRunningSummary, writeV2Summary, SUMMARY_MESSAGE_TYPE } from "./summary";
import { saysTriedAndFailed } from "./retry-signal";
import { applyBoldPolicy } from "./reply-format";
import { MESSAGE_MODEL_MIN_COVERAGE, MESSAGE_MODEL_REPEATED, announcesSending, introBeforeMaterial, lastV2ResetAt, mediaResendPlan, messageModelCoverage, pickPromisedModelId, recentMediaDeliveries, recentlySentMessageModels, resendWindowStart, saysNotReceived, recentlyAppliedRuleIds, RULE_REPLY_ACTION_TYPES } from "./sent-materials";
import { attachmentsBlockedByResend } from "./material-attachments";
import { buildV2Interactive, matchPendingOption, type V2InteractivePayload } from "./interactive";
import { simpleHandoff } from "./handoff";
import { formatCampaignDispatchBlock, hydrateOutboundTemplateContent, loadLastCampaignDispatchContext } from "@/services/ai/campaign-context";
import { pickQueueNotice, queuedMessageFor } from "./queue-notice";
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
import { getLogger } from "@/lib/logger";

const log = getLogger("ai-v2.engine");

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
  selfAgentId?: string,
): V2Destination {
  // Destino é o próprio agente (assunto/regra apontando para ele mesmo):
  // transferir para si copiava o turno, respondia de novo e transferia de
  // novo até o teto — duas respostas iguais, dois resumos, e só então a
  // equipe. Vale o destino padrão; se ele também for o próprio agente, o
  // departamento.
  // Devolver para o agente que acabou de passar a conversa (A → B → A):
  // ping-pong até o teto, com aviso e resumo a cada volta. Vale o destino
  // padrão — ou o departamento, se o padrão for um dos dois.
  if (destination.type === "ai_agent" && destination.id && counters.receivedFromAgentId && destination.id === counters.receivedFromAgentId) {
    const fallback = config.handoff.defaultDestination;
    const bounces = fallback.type === "ai_agent" && (fallback.id === counters.receivedFromAgentId || fallback.id === selfAgentId);
    const next: V2Destination = bounces ? { type: "department" } : fallback;
    traceStep("transferência", `Destino é o agente que acabou de passar a conversa → ${next.type}${next.id ? ` (${next.id})` : ""}`);
    return next;
  }
  if (destination.type === "ai_agent" && selfAgentId && destination.id === selfAgentId) {
    const fallback = config.handoff.defaultDestination;
    const next: V2Destination = fallback.type === "ai_agent" && fallback.id === selfAgentId ? { type: "department" } : fallback;
    traceStep("transferência", `Destino é o próprio agente → ${next.type}${next.id ? ` (${next.id})` : ""}`);
    return next;
  }
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
  /** Tentativas anteriores deste turno (0 = primeira). */
  attempt?: number;
  /** Momento do claim do turno: prova de posse antes de cada envio. */
  claimedAt?: Date | null;
};

/** Motivos de envio barrado que significam "uma pessoa assumiu a conversa". */
const HUMAN_TOOK_OVER = new Set(["unassigned", "assignee_changed", "assignee_not_ai", "human_replied_during_run", "human_last_outbound"]);

/** O agente de IA de destino recebe conversas em modo transparente (sem se apresentar). */
async function aiAgentReceivesTransparently(agentConfigId: string): Promise<boolean> {
  try {
    const row = await (prisma as unknown as {
      aIAgentConfig: { findUnique: (args: unknown) => Promise<{ simpleConfig?: unknown } | null> };
    }).aIAgentConfig.findUnique({ where: { id: agentConfigId }, select: { simpleConfig: true } });
    const entry = (row?.simpleConfig as { entry?: { onAiTransfer?: unknown } } | null | undefined)?.entry;
    return entry?.onAiTransfer === "continue";
  } catch {
    return false;
  }
}

/** A conversa ainda é do agente (desconhecido = segue). */
async function assignedToAgent(conversationId: string, agentUserId: string): Promise<boolean> {
  try {
    const conv = await (prisma as unknown as {
      conversation: { findUnique: (args: unknown) => Promise<{ assignedToId?: string | null } | null> };
    }).conversation.findUnique({ where: { id: conversationId }, select: { assignedToId: true } });
    if (!conv || conv.assignedToId === undefined) return true;
    return conv.assignedToId === agentUserId;
  } catch {
    return true;
  }
}

export type V2TurnResult = {
  sentReply?: string;
  handoff: boolean;
  closed: boolean;
  error?: string;
};

const STAGES_ORDERED: V2Stage[] = ["idle", "confirming", "identifying", "active", "closed"];

/** Mídia que veio junto com texto e ficou de fora ("pedir texto"). */
const MEDIA_IGNORED_NOTE: Record<string, string> = {
  audio: "[O cliente também mandou um áudio, que não dá para ouvir por aqui: responda o texto e avise em uma frase curta que só consegue ler mensagens escritas.]",
  image: "[O cliente também mandou uma imagem, que não dá para ver por aqui: responda o texto e avise em uma frase curta que não consegue abrir imagens.]",
  document: "[O cliente também mandou um documento, que não dá para abrir por aqui: responda o texto e avise em uma frase curta que não consegue abrir arquivos.]",
};

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
    log.error({ err }, "[ai-v2] invalid config");
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

/**
 * As mensagens do turno chegaram antes da última resposta do agente: o
 * turno anterior (que rodava quando elas chegaram) já respondeu.
 */
async function arrivedBeforeLastReply(conversationId: string, messageIds: string[] | undefined): Promise<boolean> {
  if (!messageIds?.length) return false;
  try {
    const db = prisma as unknown as {
      message: {
        findMany: (args: unknown) => Promise<Array<{ createdAt: Date }>>;
        findFirst: (args: unknown) => Promise<{ id: string } | null>;
      };
    };
    const own = await db.message.findMany({ where: { id: { in: messageIds } }, select: { createdAt: true } });
    if (own.length === 0) return false;
    const last = new Date(Math.max(...own.map((m) => new Date(m.createdAt).getTime())));
    const reply = await db.message.findFirst({
      where: { conversationId, direction: "out", createdAt: { gt: last } },
      select: { id: true },
    });
    return !!reply;
  } catch {
    return false;
  }
}

/**
 * Depois das mensagens deste turno o cliente mandou outra (com conteúdo) e
 * ela já foi respondida. É o turno copiado na transferência entre agentes
 * (ou reenfileirado) rodando depois do turno da mensagem seguinte:
 * responder a antiga agora manda a mesma resposta duas vezes.
 */
async function conversationMovedOn(conversationId: string, messageIds: string[] | undefined): Promise<boolean> {
  if (!messageIds?.length) return false;
  try {
    const db = prisma as unknown as {
      message: {
        findMany: (args: unknown) => Promise<Array<{ createdAt?: Date; content?: string | null; messageType?: string | null }>>;
        findFirst: (args: unknown) => Promise<{ id: string } | null>;
      };
    };
    const own = await db.message.findMany({ where: { id: { in: messageIds } }, select: { createdAt: true } });
    if (own.length === 0) return false;
    const last = new Date(Math.max(...own.map((m) => new Date(m.createdAt ?? 0).getTime())));
    const newer = await db.message.findMany({
      where: { conversationId, direction: "in", id: { notIn: messageIds }, createdAt: { gt: last } },
      select: { createdAt: true, content: true, messageType: true },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    const first = newer.find((m) => !isCourtesyOnlyInbound(m.content, m.messageType));
    if (!first?.createdAt) return false;
    const reply = await db.message.findFirst({
      where: {
        conversationId,
        direction: "out",
        isPrivate: false,
        authorType: { in: ["bot", "human"] },
        messageType: { notIn: ["note", SUMMARY_MESSAGE_TYPE] },
        createdAt: { gt: first.createdAt },
      },
      select: { id: true },
    });
    return !!reply;
  } catch {
    return false;
  }
}

/** Mensagem sem pedido: "?", "oi", "alô", "não entendi". */
export function isFillerMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // "alô?" / "ei": chamando atenção, sem pedido.
  if (/^(?:al[oô]+|ei+|hey)[\s?!.…]*$/i.test(t)) return true;
  return /^[\s?!.…]+$/.test(t) || isGreetingOnlyMessage(t) || isConfusionMessage(t, { includeState: false });
}

/** Tipos das mensagens do turno, em ordem (o turno junta várias bolhas). */
async function turnMessageTypes(messageIds: string[] | undefined): Promise<string[]> {
  if (!messageIds?.length) return [];
  try {
    const db = prisma as unknown as {
      message: { findMany: (args: unknown) => Promise<Array<{ messageType?: string | null }>> };
    };
    const rows = await db.message.findMany({
      where: { id: { in: messageIds }, direction: "in" },
      select: { messageType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.messageType ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** Resposta que traz um e-mail ou um número com cara de documento. */
export function looksLikeIdentification(text: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || (text.match(/\d/g)?.length ?? 0) >= 5;
}

/** Chegou mensagem do cliente depois das deste turno. */
/**
 * O cliente clicou de novo na mesma opção que acabou de responder (clique
 * duplo, ou a pergunta saiu em dobro e ele respondeu às duas). O agente já
 * respondeu ao primeiro clique: o segundo não vira turno. Antes o modelo
 * "confirmava de novo" e refazia a pergunta seguinte.
 */
async function isRepeatedInteractiveReply(conversationId: string, text: string, messageIds: string[] | undefined): Promise<boolean> {
  try {
    const db = prisma as unknown as {
      message: { findMany: (args: unknown) => Promise<Array<{ direction: string; content: string | null; messageType: string | null }>> };
    };
    const rows = await db.message.findMany({
      where: { conversationId, isPrivate: false, ...(messageIds?.length ? { id: { notIn: messageIds } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { direction: true, content: true, messageType: true },
    });
    if (rows.length < 2 || rows[0].direction !== "out") return false;
    const prevIn = rows.find((r) => r.direction === "in");
    if (!prevIn || (prevIn.messageType ?? "").toLowerCase() !== "interactive") return false;
    const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    return fold(prevIn.content ?? "") === fold(text) && fold(text).length > 0;
  } catch {
    return false;
  }
}

/**
 * O agente anterior já respondeu a esta mesma mensagem (turno copiado na
 * transferência entre agentes). Um atalho de palavra-chave do agente novo
 * mandava a resposta fixa em cima da resposta do anterior.
 */
async function inboundAlreadyAnswered(conversationId: string, messageIds: string[] | undefined): Promise<boolean> {
  if (!messageIds?.length) return false;
  try {
    const db = prisma as unknown as {
      message: {
        findMany: (args: unknown) => Promise<Array<{ createdAt: Date }>>;
        findFirst: (args: unknown) => Promise<{ id: string } | null>;
      };
    };
    const own = await db.message.findMany({ where: { id: { in: messageIds } }, select: { createdAt: true } });
    if (own.length === 0) return false;
    const last = new Date(Math.max(...own.map((m) => new Date(m.createdAt).getTime())));
    // Só fala de agente/pessoa conta: evento da linha do tempo e resumo
    // interno não são resposta.
    const reply = await db.message.findFirst({
      where: {
        conversationId,
        direction: "out",
        isPrivate: false,
        authorType: { in: ["bot", "human"] },
        messageType: { notIn: ["note", SUMMARY_MESSAGE_TYPE] },
        createdAt: { gt: last },
      },
      select: { id: true },
    });
    return !!reply;
  } catch {
    return false;
  }
}

/**
 * Chegou mensagem nova do cliente depois das deste turno? Agradecimento/ok
 * curto não conta: um "obrigada" à mensagem de transferência não muda a
 * dúvida — descartar a resposta por causa dele deixava o cliente sem
 * resposta nenhuma (o turno do "obrigada" só respondia "por nada").
 */
async function newerInboundArrived(conversationId: string, messageIds: string[] | undefined): Promise<boolean> {
  if (!messageIds?.length) return false;
  try {
    const db = prisma as unknown as {
      message: {
        findMany: (args: unknown) => Promise<Array<{ createdAt?: Date; content?: string | null; messageType?: string | null }>>;
      };
    };
    const own = await db.message.findMany({ where: { id: { in: messageIds } }, select: { createdAt: true } });
    if (own.length === 0) return false;
    const last = new Date(Math.max(...own.map((m) => new Date(m.createdAt ?? 0).getTime())));
    const newer = await db.message.findMany({
      where: { conversationId, direction: "in", id: { notIn: messageIds }, createdAt: { gt: last } },
      select: { content: true, messageType: true },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    return newer.some((m) => !isCourtesyOnlyInbound(m.content, m.messageType));
  } catch {
    return false;
  }
}


/** Conversa transferida esperando atendente (pendência de distribuição aberta). */
async function isWaitingInQueue(conversationId: string): Promise<boolean> {
  try {
    const pending = await (prisma as unknown as {
      distributionPending: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
    }).distributionPending.findFirst({
      where: { status: "PENDING", conversationId },
      select: { id: true },
    });
    return !!pending;
  } catch {
    return false;
  }
}

/**
 * Pendência de fila aberta a partir do momento dado (a transferência do
 * outro agente para pessoa): a conversa está na fila de pessoas, não foi
 * passada entre agentes. Pendência antiga, sem data ou anterior, não conta.
 */
async function queuedSince(conversationId: string, since: Date | undefined): Promise<boolean> {
  if (!since) return false;
  try {
    const pending = await (prisma as unknown as {
      distributionPending: { findFirst: (args: unknown) => Promise<{ id: string; createdAt?: Date | string | null } | null> };
    }).distributionPending.findFirst({
      where: { status: "PENDING", conversationId },
      select: { id: true, createdAt: true },
    });
    if (!pending?.createdAt) return false;
    return new Date(pending.createdAt).getTime() >= new Date(since).getTime() - 5_000;
  } catch {
    return false;
  }
}

/** Devolve a conversa à fila: sem responsável IA, como no handoff. */
async function releaseToQueue(conversationId: string): Promise<void> {
  await (prisma as unknown as {
    conversation: { updateMany: (args: unknown) => Promise<unknown> };
  }).conversation.updateMany({
    where: { id: conversationId, assignedTo: { type: "AI" } },
    data: { assignedToId: null },
  }).catch(() => undefined);
}

/** Aviso do "avisar e silenciar". Usa a mensagem de escopo quando configurada. */
function stopWarning(config: V2AgentConfig, reason: string): string {
  if (reason === "loop detectado") return systemMessage(config, "loopWarning");
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
    config,
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
    log.error({ err }, "[ai-v2] ensureV2AgentSchema falhou");
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

  // Nova tentativa do mesmo turno depois de uma falha: se a anterior já tinha
  // respondido (o erro veio depois do envio), não responde de novo — o
  // cliente recebia duas respostas, às vezes diferentes.
  if ((input.attempt ?? 0) > 0 && (await arrivedBeforeLastReply(input.conversationId, input.messageIds))) {
    traceStep("entrada", `Tentativa ${(input.attempt ?? 0) + 1} deste turno: a anterior já respondeu antes de falhar → não repete`);
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      prompt: "", executedActions: [], discardedActions: [{ type: "no_reply", reason: "already replied in a previous attempt" } as any],
      handoff: false, latencyMs: Date.now() - startedAt, inputTokens: 0, outputTokens: 0, owner: "agente", stage: "active",
    }).catch(() => undefined);
    return { handoff: false, closed: false };
  }

  // Posse do turno: o sweeper devolve para a fila um turno que passou do
  // teto de tempo e outro processo o reprocessa. Quem perdeu a posse para de
  // enviar (senão o cliente recebia a resposta dos dois).
  const ownsTurn = async (): Promise<boolean> => {
    if (!input.turnId || !input.claimedAt) return true;
    try {
      const row = await (prisma as unknown as {
        conversationTurn: { findUnique: (args: unknown) => Promise<{ status: string; claimedAt: Date | null } | null> };
      }).conversationTurn.findUnique({ where: { id: input.turnId }, select: { status: true, claimedAt: true } });
      if (!row) return true;
      return row.status === "PROCESSING" && !!row.claimedAt && new Date(row.claimedAt).getTime() === new Date(input.claimedAt).getTime();
    } catch {
      return true;
    }
  };
  // Resumo para a equipe antes de transferir (quando ligado): quem recebe
  // a conversa — pessoa ou outro agente — lê o que já aconteceu.
  const summarizeBeforeHandoff = (destination: { type: string }, tabulation?: string | null) =>
    writeV2Summary({
      organizationId: orgId,
      conversationId: input.conversationId,
      contactId,
      agentId: resolved!.agentConfigId,
      config,
      moment: "transfer",
      reason: destination.type,
      tabulation,
    });

  // Uma pessoa assumiu a conversa durante o turno: o agente para de enviar,
  // não transfere e não manda materiais.
  let humanTookOver = false;

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
  // O "digitando…" desconta o tempo que o turno já levou pensando.
  const humanBehavior = { ...v2HumanBehavior(config), turnStartedAt: startedAt };
  let counters = parseV2Counters(stateRow?.counters);
  // Opções da última resposta (botões/lista/numeradas): o clique ou o número
  // ("2") vira o rótulo da opção, que é o que o modelo e as regras entendem.
  // Valem só para a próxima mensagem do cliente.
  const pendingOptions = counters.pendingOptions ?? [];
  let chosenOption: string | null = null;
  if (pendingOptions.length > 0) {
    counters.pendingOptions = undefined;
    const chosen = matchPendingOption(pendingOptions, input.userMessage);
    chosenOption = chosen;
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
  if ((input.messageType ?? "").toLowerCase() === "interactive" && (await isRepeatedInteractiveReply(input.conversationId, input.userMessage, input.messageIds))) {
    traceStep("opções", "Clique repetido na opção que acabou de ser respondida → sem novo turno");
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
      prompt: "repeat_click", executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, versionId,
    });
    return { handoff: false, closed: false };
  }
  // A conversa está atribuída a este agente v2 com owner=pessoa: ou é estado
  // antigo (humano anterior, handoff que não trocou o responsável) — o motor
  // ficava mudo com o agente como responsável — ou a conversa transferida
  // voltou ao agente enquanto espera na fila (o cliente escreveu de novo).
  // Na fila vale "Chamar a equipe › Enquanto espera na fila": antes o agente
  // reassumia, transferia de novo e a trava anti-repetição engolia o aviso.
  // Conversa que outro agente de IA passou para este: o dono agora é este
  // agente, não uma pessoa na fila. Antes o agente que recebia via "cliente
  // na fila", devolvia a conversa à fila e ela ficava sem responsável.
  const handedByAnotherAgent = !!stateRow && stateRow.agentId !== resolved.agentConfigId;
  if (handedByAnotherAgent) {
    traceStep("agente", "Conversa recebida de outro agente de IA → este agente assume");
    // Quem passou a conversa: não devolver para ele (ping-pong entre agentes).
    counters.receivedFromAgentId = stateRow!.agentId;
    // A conversa já está em atendimento: sem boas-vindas nem confirmação de
    // cadastro de novo — o cliente já disse o que precisa ao agente anterior
    // e a mensagem copiada é essa. Antes o agente novo mandava "Olá! Sou seu
    // assistente… Confirmo que estou falando com…" e ignorava o pedido.
    if (stage === "idle" || stage === "confirming") {
      traceStep("entrada", "Recebida de outro agente: sem boas-vindas nem confirmação de cadastro — responde direto ao pedido");
      stage = "active";
    }
    // A transferência entre agentes copia o turno: o agente novo reprocessa
    // a MESMA mensagem. Com o contador herdado, uma mensagem que passou por
    // três agentes contava como três repetições, e o terceiro, em vez de
    // responder, mandava o aviso de loop.
    if (counters.loopCount > 0 || counters.lastLoopMessage) {
      counters.loopCount = 0;
      counters.lastLoopMessage = undefined;
      traceStep("limites", "Contador de repetição zerado: a mensagem é a mesma que o agente anterior recebeu, não uma repetição do cliente");
    }
  }
  // O outro agente passou a conversa para PESSOA (a pendência de fila nasceu
  // nessa transferência) e ela chegou a este agente pela distribuição, não
  // por transferência entre agentes: é fila de pessoas. Assumir aqui era
  // responder "posso ajudar em mais alguma coisa?" a quem só agradeceu e
  // espera a equipe. Devolve à fila e não responde.
  if (handedByAnotherAgent && owner === "pessoa" && (await queuedSince(input.conversationId, stateRow?.updatedAt))) {
    traceStep("fila", "Conversa na fila de pessoas desde a transferência do outro agente → este agente não assume; devolve à fila");
    await releaseToQueue(input.conversationId);
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
      prompt: "", executedActions: [], discardedActions: [{ type: "no_reply", reason: "queued" } as any],
      handoff: false, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, versionId,
    });
    return { handoff: false, closed: false };
  }
  // Transferência transparente: este agente segue como se fosse o mesmo
  // assistente (o modelo é instruído a não se apresentar).
  const transparentTransfer = handedByAnotherAgent && config.entry.onAiTransfer === "continue";
  if (transparentTransfer) traceStep("agente", "Transferência transparente: segue o atendimento sem se apresentar");
  const waitingInQueue = owner === "pessoa" && !handedByAnotherAgent && (await isWaitingInQueue(input.conversationId));
  const queueMode = config.handoff.whileQueued ?? "notify";
  if (waitingInQueue) traceStep("fila", `Conversa transferida voltou ao agente com o cliente na fila → "${queueMode === "notify" ? "só avisar" : "responder"}"`);
  if (owner === "pessoa" && !(waitingInQueue && queueMode === "notify")) {
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
  traceStep("dados", describeV2ContextForTrace(config, loadedContext));

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
  // Textos das mensagens com opções (lista/botões) definidos pela empresa.
  const optionTexts = { prompt: systemMessage(config, "optionsPrompt"), button: systemMessage(config, "optionsButton") };

  // "?" ou "oi" mandado enquanto ele respondia a mensagem anterior: essa
  // resposta já saiu depois e cobre. Responder de novo duplicava tudo.
  if (
    stage !== "closed" &&
    !(owner === "pessoa" && waitingInQueue) &&
    (!input.messageType || input.messageType === "text") &&
    isFillerMessage(input.userMessage) &&
    (await arrivedBeforeLastReply(input.conversationId, input.messageIds))
  ) {
    traceStep("entrada", "Mensagem sem pedido novo que chegou enquanto ele respondia a anterior → sem resposta (a resposta já cobriu)");
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context,
      prompt: "", executedActions: [], discardedActions: [{ type: "no_reply", reason: "answered meanwhile" } as any],
      handoff: false, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, versionId,
    });
    return { handoff: false, closed: false };
  }

  // Turno de uma mensagem antiga (copiado na transferência entre agentes ou
  // reenfileirado): o cliente já mandou outra depois e ela já foi
  // respondida. Responder a antiga agora duplica a resposta.
  if (stage !== "closed" && (await conversationMovedOn(input.conversationId, input.messageIds))) {
    traceStep("entrada", "O cliente já mandou outra mensagem depois desta e ela já foi respondida → este turno não responde");
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context,
      prompt: "", executedActions: [], discardedActions: [{ type: "no_reply", reason: "conversation moved on" } as any],
      handoff: false, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, versionId,
    });
    return { handoff: false, closed: false };
  }

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
      masks: fieldMasks(config),
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

  // Na fila, modo "avisar": responde só o aviso e devolve a conversa à fila.
  if (owner === "pessoa" && waitingInQueue) {
    // O aviso acompanha o que o cliente escreveu (cancelar, reclamação,
    // "alô?") e nunca repete o anterior; antes só o primeiro saía e o resto
    // era barrado pela trava anti-repetição, com o cliente sem resposta.
    const last = await Promise.resolve()
      .then(() =>
        prisma.message.findFirst({
          where: { conversationId: input.conversationId, direction: "out", isPrivate: false, messageType: { not: "note" } },
          orderBy: { createdAt: "desc" },
          select: { content: true, createdAt: true },
        }),
      )
      .catch(() => null);
    // Fora do horário o aviso não promete "em instantes": o padrão muda e as
    // variantes com essa promessa ficam de fora (antes saía "em instantes"
    // seguido de "seguimos no próximo horário").
    const queueWithinHours = isWithinV2BusinessHours(config);
    const picked = pickQueueNotice({
      message: input.userMessage,
      configured: renderMessage(queuedMessageFor(config.handoff.queuedMessage, queueWithinHours, systemMessage(config, "queueOutsideHours")), vars, defaultFormatter()),
      overrides: {
        cancel: customSystemMessage(config, "queueCancel"),
        upset: customSystemMessage(config, "queueUpset"),
        call: customSystemMessage(config, "queueCall"),
        again: customSystemMessage(config, "queueAgain"),
      },
      lastReply: last?.content ?? null,
      lastReplyAt: last?.createdAt ?? null,
      outsideHours: !queueWithinHours,
    });
    const hoursNote = picked?.kind === "first" ? outsideHoursNote(config) : "";
    const notice = picked ? [picked.text, hoursNote].filter(Boolean).join("\n\n") : "";
    if (picked) traceStep("fila", `Aviso de fila (${picked.kind === "first" ? "primeiro" : picked.kind === "cancel" ? "pedido de cancelar" : picked.kind === "upset" ? "cliente insatisfeito" : picked.kind === "call" ? "cliente chamando" : "nova mensagem"})`);
    else traceStep("fila", "Mensagens seguidas em poucos segundos: o aviso anterior vale");
    const res = picked
      ? await sendV2TextMessage({
          conversationId: input.conversationId,
          contactId,
          agentUserId: resolved!.userId,
          text: notice,
          channel: input.channel,
          autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
          humanBehavior,
          bypassDuplicateGuard: picked.kind !== "first",
        })
      : { sent: false, reason: "queued_quiet" };
    await releaseToQueue(input.conversationId);
    await logV2Turn({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: context,
      prompt: "queued",
      ...(res.sent ? { reply: notice } : {}),
      executedActions: [],
      discardedActions: res.sent ? [] : [{ type: "no_reply", reason: "queued" } as any],
      handoff: false,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      owner,
      stage,
      versionId,
    });
    return { handoff: false, closed: false, ...(res.sent ? { sentReply: notice } : {}) };
  }

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
    const caseType = answerToPostCloseQuestion(config, pendingOptions, chosenOption) ?? classifyPostCloseMessage(config, input.userMessage);
    let behavior = getPostCloseBehavior(config, caseType);
    // A pergunta sai uma vez por janela: repetida, a conversa andava em
    // círculo ("??" → pergunta de novo). Depois dela, o ambíguo volta para o
    // agente, que pergunta do jeito dele; agradecimento vira resposta curta.
    if (behavior === "ask_with_options" && counters.postCloseAsked) {
      behavior = caseType === "courtesy" ? "short_reply" : "reopen_and_route";
      traceStep("pós-encerramento", "A pergunta já foi feita nesta janela → não repete");
    }
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
        skipAutomations: !(await flowsOnAiClose()),
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
    } else if (behavior === "handoff") {
      // "Transferir para a equipe" depois de encerrar, com o aviso do caso.
      counters.postCloseAsked = false;
      await handoffAndReply(
        resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId,
        renderMessage(postCloseHandoffMessage(config, caseType), vars, defaultFormatter()),
        counters, themeId,
      );
      return { handoff: true, closed: false };
    } else if (behavior === "reopen_and_route") {
      stage = "active";
      owner = "agente";
      counters.courtesyReplies = 0;
      counters.postCloseAsked = false;
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
      const short = renderMessage(postCloseShortReply(config, caseType), vars, defaultFormatter());
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
      // Botões (ou opções numeradas onde não há botão); a resposta volta
      // pelas opções pendentes e decide o caso no próximo turno.
      const q = postCloseQuestion(config);
      const built = buildV2Interactive(renderMessage(q.message, vars, defaultFormatter()), [q.yes, q.no], optionTexts);
      const reply = built.fallbackText;
      const sent = await sendV2TextMessage({
        conversationId: input.conversationId,
        contactId,
        agentUserId: resolved!.userId,
        text: reply,
        channel: input.channel,
        autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
        humanBehavior,
        interactive: built.payload,
      });
      if (sent.sent) {
        counters.pendingOptions = built.labels;
        counters.postCloseAsked = true;
      }
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
  // sem zerar, uma cortesia antiga bloquearia toda resposta futura. A
  // pergunta pós-encerramento volta a valer no próximo encerramento.
  counters.courtesyReplies = 0;
  counters.postCloseAsked = false;

  // Mídia recebida
  // A política vale para a mídia do turno, em qualquer bolha: antes só o tipo
  // da última decidia (imagem e depois "aparece isso" ignorava a imagem).
  const turnMediaType = (await turnMessageTypes(input.messageIds)).find((t) => detectV2MediaKinds(t).length > 0);
  const media = evaluateV2Media(config, turnMediaType ?? input.messageType);
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
  // Imagem com legenda chega só com a legenda no texto (sem "[Imagem]").
  const understandsMedia = (["transcribe", "describe"] as string[]).some(
    (a) => a === config.media.audio?.action || a === config.media.image?.action,
  );
  const turnHasMedia = understandsMedia && (turnLines.some((l) => isMediaPlaceholderText(l)) || !!turnMediaType);
  if (media && media.action === "ask_text") {
    if (!turnHasText) return replyAndWait(media.message || MEDIA_ASK_TEXT_DEFAULT[media.kind], "media ask_text");
    traceStep("mídia", "Mídia veio junto com texto → responde o texto e avisa que a mídia não foi vista");
    // O cliente não sabia que a mídia ficou de fora.
    const note = MEDIA_IGNORED_NOTE[media.kind];
    const kept = turnLines.filter((l) => !isMediaPlaceholderText(l));
    input = { ...input, userMessage: [...kept, note].join("\n") };
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
    const mediaDestination = resolveHandoffDestination(config, config.handoff.defaultDestination, counters, resolved!.agentConfigId);
    if (mediaDestination.type === "ai_agent") counters.aiTransferCount += 1;
    await summarizeBeforeHandoff(mediaDestination);
    await simpleHandoff({
      conversationId: input.conversationId,
      contactId,
      dealId: loadedContext.dealId,
      destination: mediaDestination,
      turnId: input.turnId,
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
  let rule = evaluateV2Rules(config, {
    userMessage: input.userMessage,
    messageType: input.messageType,
    isFirstMessage: !stateRow || (stateRow.stage as V2Stage) === "idle",
    contactTags: (loadedContext.contactRaw?.tags as string[] | undefined) ?? [],
    dealStageName: loadedContext.selectedDealRaw?.stageName as string | undefined,
    dealStageId: loadedContext.selectedDealRaw?.stageId as string | undefined,
    dealPipelineName: loadedContext.selectedDealRaw?.pipelineName as string | undefined,
    withinBusinessHours,
    mediaKinds: media ? [media.kind] : [],
    surveyReceived: counters.surveyPending,
  }, ruleContext);

  // Atalho com mensagem fixa responde uma vez por conversa. Casando de novo
  // (a palavra-chave continua na mensagem), a resposta fixa não sai: a
  // mensagem segue para o agente, que já viu o que foi mandado — e, se o
  // cliente disser que não deu certo, transfere com o contexto.
  if (rule && rule.actions.some((a) => RULE_REPLY_ACTION_TYPES.has(a.type))) {
    const fired = await recentlyAppliedRuleIds(input.conversationId).catch(() => new Set<string>());
    if (fired.has(rule.id)) {
      traceStep("regra", `Atalho "${rule.name ?? rule.id}" já respondeu nesta conversa → não repete; a mensagem segue para o agente`);
      counters.guidanceGiven = true;
      rule = null;
    } else if (handedByAnotherAgent && (await inboundAlreadyAnswered(input.conversationId, input.messageIds))) {
      traceStep("regra", `Atalho "${rule.name ?? rule.id}" casou, mas o agente anterior já respondeu a esta mensagem → não repete; segue para o agente`);
      rule = null;
    }
  }
  let appliedRuleId = rule?.id;
  traceStep("regra", rule
    ? `Regra "${rule.name ?? rule.id}" casou → ações: ${(rule.actions as Array<{ type: string }>).map((a) => a.type).join(", ") || "nenhuma"}`
    : "Nenhuma regra automática casou", rule ? { ruleId: rule.id } : undefined);

  // Limites de parada: avaliados UMA vez por turno (a detecção de loop soma
  // a cada chamada; antes contava duas vezes quando uma regra casava).
  const stop = evaluateV2StopLimits(config, counters, input.userMessage);
  if (stop.blocksReply) traceStep("limites", `Limite de parada atingido: ${stop.reason} → ${stop.action}`);

  // Depois de "me conta em uma frase o que você precisa": a frase chegou →
  // transfere com ela, como prometido. Antes voltava para o agente, que
  // perguntava tudo de novo e o cliente rodava em círculo.
  if (counters.humanRequestPending) {
    counters.humanRequestPending = false;
    if (!isShortAckText(input.userMessage) && !isGreetingOnlyMessage(input.userMessage)) {
      noteV2Fact("handoffCause", "human_request", { keepFirst: true });
      traceStep("transferência", "Cliente disse o que precisa depois do pedido de atendente → transfere com o assunto");
      await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, renderMessage(config.handoff.message, vars, defaultFormatter()), counters, themeId);
      return { handoff: true, closed: false };
    }
  }
  // Depois de uma orientação (passo a passo, mensagem pronta, material), o
  // cliente diz que já tentou e não deu certo — ou clica em "preciso de
  // ajuda". Repetir material ou menu é a pior resposta: transfere com o
  // contexto (o resumo, quando ligado, vai junto).
  if (counters.guidanceGiven && (saysTriedAndFailed(input.userMessage) || (chosenOption && mentionsHumanRequest(config, chosenOption)))) {
    noteV2Fact("handoffCause", "tried_and_failed", { keepFirst: true });
    traceStep("transferência", chosenOption
      ? "Pedido de ajuda depois de uma orientação → transfere com o contexto, sem perguntar de novo"
      : "Cliente já tentou e não deu certo → sem reenviar orientação; transfere com o contexto");
    await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, renderMessage(systemMessage(config, "triedAndFailedHandoff"), vars, defaultFormatter()), counters, themeId);
    return { handoff: true, closed: false };
  }

  // Resumo do atendimento anterior (ou o corrente): contexto para o modelo.
  let priorSummary: Awaited<ReturnType<typeof loadPriorV2Summary>> = null;
  try {
    priorSummary = (await loadPriorV2Summary({ contactId, conversationId: input.conversationId, runningSummary: counters.runningSummary })) ?? null;
  } catch {
    priorSummary = null;
  }
  if (priorSummary) traceStep("resumo", priorSummary.current ? "Resumo corrente desta conversa entra no contexto" : "Resumo do último atendimento do cliente entra no contexto");

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
  // Adiamento ("chamo depois", "agora não posso", "estou no trabalho"):
  // não é pedido nem cortesia pura. Responde curto, sem fecho nem botões,
  // e encerra — a volta entra pela janela pós-encerramento (cortesia /
  // nova demanda). Antes virava "posso ajudar em mais alguma coisa?" com
  // botões para quem acabou de dizer que não pode agora.
  if (stage !== "closed" && !chosenOption && (!input.messageType || input.messageType === "text") && isDeferralText(input.userMessage)) {
    traceStep("entrada", "Cliente adiou (“chamo depois”) → resposta curta, sem fecho, e encerra");
    const deferralText = renderMessage(systemMessage(config, "deferralReply"), vars, defaultFormatter());
    const deferralRes = deferralText.trim() ? await sendReply(deferralText) : { sent: false, reason: "empty" };
    await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, "deferred", loadedContext.contactId, collectedVariables, getV2ThemeById(config, themeId));
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage, crmContext: context, prompt: "deferral", reply: deferralRes.sent ? deferralText : undefined,
      executedActions: [{ action: { type: "close_conversation" }, ok: true, reason: "deferred" } as any], discardedActions: [],
      handoff: false, closed: true, latencyMs: Date.now() - startedAt,
      inputTokens: 0, outputTokens: 0, owner, stage, versionId, themeId,
    });
    return { handoff: false, closed: true };
  }

  // O cliente pediu uma pessoa e fez uma pergunta na mesma mensagem: o modelo
  // responde a pergunta e só marca transferência se não conseguir.
  let humanRequestWithSubject = false;

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
    let ruleHandoff = ruleActions.find((a) => a.type === "handoff");
    const otherRuleActions = ruleActions.filter((a) => a.type !== "handoff");
    // Pedido de pessoa: com pergunta ou assunto junto, o agente responde
    // primeiro e só transfere se não conseguir (ou se o cliente insistir).
    // Só o pedido, sem assunto: pergunta uma vez o que a pessoa precisa e
    // transfere na mensagem seguinte.
    if (ruleHandoff && mentionsHumanRequest(config, input.userMessage)) {
      if (humanRequestSubject(config, input.userMessage)) {
        humanRequestWithSubject = true;
        counters.humanRequestAsked = true;
        ruleHandoff = undefined;
        traceStep("regra", "Pedido de pessoa junto com uma pergunta → responde primeiro; transfere só se não conseguir");
      } else if (!counters.humanRequestAsked) {
        counters.humanRequestAsked = true;
        counters.humanRequestPending = true;
        traceStep("regra", "Pedido de pessoa sem dizer o assunto → pergunta uma vez o que precisa; transfere na próxima mensagem");
        const ask = renderMessage(systemMessage(config, "humanRequestAsk"), vars, defaultFormatter());
        await sendReply(ask);
        await upsertV2ConversationState({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
          owner, counters: counters as V2Counters, versionId: versionId, collectedVariables,
        });
        await logV2Turn({
          organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
          inboundText: input.userMessage, crmContext: context, prompt: "rule", reply: ask,
          executedActions: [], discardedActions: [], handoff: false, closed: false, latencyMs: Date.now() - startedAt,
          inputTokens: 0, outputTokens: 0, owner, stage, appliedRuleId, versionId,
        });
        return { handoff: false, closed: false, sentReply: ask };
      }
    }
    const res = await executeV2Actions(otherRuleActions, actionCtx);
    executedActions = res.results;
    // Resposta fixa do atalho conta como orientação dada.
    if (res.results.some((r) => r.ok && RULE_REPLY_ACTION_TYPES.has(r.action.type as string))) counters.guidanceGiven = true;
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

    // Encerramento antes do log: é ele que tabula, e a tabulação precisa
    // entrar no registro do turno (relatório de ações).
    if (anyClose && !anyHandoff) {
      await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, "rule", loadedContext.contactId, collectedVariables, getV2ThemeById(config, themeId));
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
    // Identificando: vale também com negócio carregado. Quem disse "não sou
    // eu" não pode ser atendido com os dados do cadastro do número.
    if (!loadedContext.selectedDeal || stage === "identifying") {
      const onDealNotFound = config.entry.onDealNotFound;
      traceStep("entrada", stage === "identifying"
        ? "Aguardando o cliente se identificar"
        : `Nenhum negócio do contato encontrado → "${onDealNotFound}"`);
      if (stage !== "identifying" && onDealNotFound === "handoff") {
        noteV2Fact("handoffCause", "identification", { keepFirst: true });
        await handoffAndReply(resolved, orgId, contactId, loadedContext, input, config, stateRow, versionId, renderMessage(config.handoff.message, vars, defaultFormatter()), counters);
        return { handoff: true, closed: false };
      } else if (stage !== "identifying" && onDealNotFound === "create_deal") {
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
        // O motor não vincula cadastro pelo dado que o cliente digita: quem
        // digita o documento de outra pessoa receberia os dados dela. A equipe
        // localiza o cadastro. Resposta com e-mail/documento → transfere; sem
        // nada disso, pede de novo até `entry.maxAttempts` vezes.
        const asked = stage === "identifying" ? Math.max(1, stateRow?.identificationAttempts ?? 1) : 0;
        const answered = asked > 0 && looksLikeIdentification(input.userMessage);
        if (answered) traceStep("entrada", "Cliente mandou e-mail/documento → a equipe localiza o cadastro");
        if (answered || asked >= (config.entry.maxAttempts ?? 2)) {
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
          parts.push(renderMessage(systemMessage(config, "identificationRetry"), vars, defaultFormatter()));
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
      const dispatchReply = config.useDispatchText
        ? await loadLastCampaignDispatchContext(input.conversationId, contactId, { chatOnly: true })
        : null;
      // Boas-vindas sem confirmação: antes só saíam junto da confirmação ou
      // da identificação — com "Confirmar" desligado, nunca, e o modelo
      // improvisava o cumprimento. Saem quando a primeira mensagem é só
      // cumprimento; se já traz o pedido, ele responde direto (perguntar
      // "como posso ajudar?" a quem já disse parece que não leu).
      // Resposta a um disparo não recomeça: o texto do modelo entra no prompt.
      if (dispatchReply?.body) {
        traceStep("entrada", "Resposta a um disparo → segue sem boas-vindas");
      } else if (config.entry.openingEnabled && config.entry.openingMessage?.trim()) {
        if (!isGreetingOnlyMessage(input.userMessage)) {
          traceStep("entrada", "Primeira mensagem já traz o pedido → responde direto, sem as boas-vindas");
        } else {
          const superseded = await newerInboundArrived(input.conversationId, input.messageIds);
          const rendered = superseded ? "" : renderMessage(config.entry.openingMessage, vars, defaultFormatter());
          traceStep("entrada", superseded
            ? "O cliente já mandou outra mensagem: as boas-vindas não saem — a próxima resposta cobre"
            : "Primeira mensagem só com cumprimento → boas-vindas configuradas");
          // Confere de novo depois do "digitando…": o pedido pode chegar nele.
          const welcome = rendered && (await sendReply(rendered, null, { dropIfSuperseded: true })).sent ? rendered : "";
          await upsertV2ConversationState({
            organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId,
            stage: "active", versionId: versionId,
          });
          await logV2Turn({
            organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
            inboundText: input.userMessage, crmContext: context, prompt: "welcome", ...(welcome ? { reply: welcome } : {}),
            executedActions: [], discardedActions: [], handoff: false, latencyMs: Date.now() - startedAt,
            inputTokens: 0, outputTokens: 0, owner, stage: "active", versionId,
          });
          return { handoff: false, closed: false, ...(welcome ? { sentReply: welcome } : {}) };
        }
      }
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
      const llmForStep = await callLLMWithTheme(config, context, input, resolved, themeId, collectedVariables, rule, owner, stage, false, priorSummary, transparentTransfer);
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
    // Resposta a uma pergunta do agente fica no assunto em andamento.
    const lastOut = themeId && !themeFromRule
      ? await Promise.resolve()
          .then(() =>
            prisma.message.findFirst({
              where: { conversationId: input.conversationId, direction: "out", isPrivate: false, messageType: { not: "note" } },
              orderBy: { createdAt: "desc" },
              select: { content: true },
            }),
          )
          .catch(() => null)
      : null;
    const selection: V2ThemeSelection = themeFromRule
      ? { theme: getV2ThemeById(config, themeId), method: "kept" }
      : await selectV2ThemeSemantic({
          config,
          message: input.userMessage,
          currentThemeId: themeId,
          apiKey: await tryGetAgentApiKey(resolved.agentConfigId),
          answeringQuestion: agentAskedQuestion(lastOut?.content ?? null, config),
        });
    themeId = selection.theme?.id ?? themeId;
    traceStep("assunto", selection.theme
      ? `Assunto "${selection.theme.name}" — ${
          selection.method === "trigger"
            ? "um gatilho casou com a mensagem"
            : selection.method === "semantic"
              ? `mais próximo em significado (similaridade ${selection.similarity?.toFixed(2)})`
              : selection.answer
                ? "mantido: o cliente respondia a uma pergunta do agente"
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
      const llmResult = await callLLMWithTheme(config, context, input, resolved, themeId, collectedVariables, rule, owner, stage, humanRequestWithSubject, priorSummary, transparentTransfer);
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

  // O modelo demorou e o turno foi retomado por outro processo: esta
  // execução não envia mais nada (a outra responde).
  if (!(await ownsTurn())) {
    traceStep("parada", "Turno retomado por outro processo (passou do teto de tempo) → esta execução não envia");
    return { handoff: false, closed: false, error: "Turno retomado por outro processo (passou do teto de tempo)" };
  }

  // Guarda "sem material": nada nos materiais cobre a mensagem e a resposta
  // afirma fatos (número, prazo, passo, caminho, link) que não vêm do
  // cadastro do cliente. Aplica a saída configurada.
  let noSourceApplied = false;
  if (llmOutput) {
    const guarded = applyNoSourceGuard({
      config,
      output: llmOutput,
      context,
      toolCalls,
      queriedEmpty: allQueryToolResultsEmpty(toolCalls),
      prefetch: peekV2Fact("prefetch") as V2PrefetchFact | undefined,
      themeId,
    });
    if (guarded.applied && guarded.explanationDropped) {
      traceStep("verificação", "Nada nos materiais cobre a mensagem e a explicação antes da transferência afirmava fatos → só o aviso de transferência sai");
    } else if (guarded.applied) {
      noSourceApplied = !guarded.handoff;
      if (guarded.handoff) noteV2Fact("handoffCause", "no_source", { keepFirst: true });
      traceStep("verificação", guarded.handoff
        ? "Nada nos materiais cobre a mensagem e a resposta afirmava fatos → transfere"
        : "Nada nos materiais cobre a mensagem e a resposta afirmava fatos → mensagem \"sem material\"");
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
      noSourceApplied = true;
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
  const allowedFlowIds = allowedFlowIdsFor(config);
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
    if (a.type === "send_whatsapp_flow" && !allowedFlowIds.includes(String((a as { flowId?: unknown }).flowId ?? ""))) {
      discardedActions.push(a);
      continue;
    }
    allowedActions.push(a);
  }

  if (discardedActions.length > 0) {
    traceStep("ações", `Descartadas (fora do permitido neste assunto/config): ${discardedActions.map((a) => a.type).join(", ")}`);
  }

  // Cliente confuso ("?", "não entendi"): "Quando não souber › Cliente
  // confuso" = refazer (padrão) — refaz a última pergunta em vez de
  // transferir. Pedido de pessoa continua transferindo.
  if (
    wantsHandoff &&
    (config.fallback?.confusion?.action ?? "rephrase") === "rephrase" &&
    peekV2Fact("handoffCause") === "model" &&
    isConfusionMessage(input.userMessage)
  ) {
    wantsHandoff = false;
    requestedDestination = undefined;
    llmOutput.handoff = false;
    llmOutput.reply = rephraseAfterConfusion(lastAgentMessage, config);
    traceStep("resposta", "Cliente mostrou que não entendeu → refaz a pergunta em vez de transferir");
  }

  // "Se continuar divergente, encaminho": a resposta condiciona a
  // transferência ao que o cliente vai conferir. Transferir já deixava o
  // cliente na fila sem ter conferido; ele responde e o próximo turno decide.
  let conditionalWait = false;
  if (wantsHandoff && peekV2Fact("handoffCause") === "model" && !llmOutput.concluded && conditionalHandoff(llmOutput.reply)) {
    wantsHandoff = false;
    requestedDestination = undefined;
    llmOutput.handoff = false;
    conditionalWait = true;
    traceStep("transferência", "A resposta condiciona a transferência (“se … encaminho”) → espera o cliente responder");
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
  // Conteúdo da empresa que a resposta pode citar: trechos lidos e o texto das
  // mensagens prontas (links delas saem mesmo fora dos endereços liberados) —
  // a escolhida e, quando a resposta traz link, as liberadas no assunto: o
  // modelo vê o texto delas e às vezes o copia sem pedir o envio ou com o id
  // errado; o link saía como não liberado e sobrava "Android:" vazio.
  const chosenModelIds = (llmOutput.actions ?? [])
    .filter((a) => a.type === "send_message_model" && typeof a.modelId === "string")
    .map((a) => a.modelId as string);
  const ownerModelIds = [...new Set([...chosenModelIds, ...(/https?:\/\//i.test(llmOutput.reply) ? allowedModelIds : [])])];
  const chosenModelTexts = ownerModelIds.length > 0
    ? ((await Promise.resolve()
        .then(() => prisma.messageTemplate.findMany({ where: { id: { in: ownerModelIds }, organizationId: orgId }, select: { content: true } }))
        .catch(() => [])) ?? []).map((r) => r.content ?? "")
    : [];
  const guard = guardV2Output(llmOutput.reply, config.allowedDomains, {
    contact: context.contact,
    citableContact: context.citableContact ?? null,
    selectedDeal: context.selectedDeal,
    citableDeal: context.citableDeal ?? null,
    publicTexts: [input.userMessage],
    ownerTexts: [...knowledgeChunkTexts(toolCalls), ...chosenModelTexts],
  }, systemMessage(config, "returnPromiseHandoff"));
  // Negrito conforme "Quem é o agente › Destaques em negrito".
  let replyText = applyBoldPolicy(guard.text, config.bold);
  // "Vou te enviar a orientação" sem mensagem pronta deixava o cliente sem
  // nada. Se o assunto tem uma que combina com o pedido, ela sai neste turno.
  if (
    announcesSending(replyText) &&
    !llmOutput.actions.some((a) => a.type === "send_message_model" || a.type === "send_material_attachment") &&
    allowedModelIds.length > 0 &&
    allowedTools.has("send_message_model")
  ) {
    const rows = await Promise.resolve()
      .then(() =>
        prisma.messageTemplate.findMany({
          where: { id: { in: allowedModelIds }, organizationId: orgId },
          select: { id: true, name: true, content: true },
        }),
      )
      .catch(() => [] as Array<{ id: string; name: string; content: string | null }>);
    const promisedId = pickPromisedModelId(replyText, input.userMessage, rows ?? []);
    if (promisedId) {
      allowedActions.push({ type: "send_message_model", modelId: promisedId });
      traceStep("ações", "Prometeu enviar e não escolheu mensagem pronta — enviada a do assunto que combina com o pedido");
    }
  }
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
  const OUTBOUND_ACTIONS = new Set(["send_message_model", "send_product", "send_whatsapp_template", "send_whatsapp_flow", "send_message", "send_material_attachment"]);
  let outboundActions = allowedActions.filter((a) => OUTBOUND_ACTIONS.has(a.type));
  // Resposta trocada pela mensagem "sem material": anexo de material não cabe.
  if (noSourceApplied) outboundActions = outboundActions.filter((a) => a.type !== "send_material_attachment");
  // Mensagem pronta enviada há pouco (cliente repetiu o pedido): não sai de
  // novo. Antes a introdução ("vou te enviar…") saía, o texto era barrado
  // pela trava anti-repetição e o cliente ficava sem nada.
  const requestedModelIds = outboundActions
    .filter((a) => a.type === "send_message_model" && typeof a.modelId === "string")
    .map((a) => a.modelId as string);
  if (requestedModelIds.length > 0) {
    const alreadySent = await recentlySentMessageModels(input.conversationId, requestedModelIds).catch(() => new Set<string>());
    if (alreadySent.size > 0) {
      // "Não recebi o vídeo": decide pelo que saiu de fato (a entrega). Antes
      // a resposta era "te enviei logo acima 👆" com o envio marcado como falha.
      let plan: ReturnType<typeof mediaResendPlan> = null;
      if (saysNotReceived(input.userMessage)) {
        const since = resendWindowStart(Date.now(), await lastV2ResetAt(input.conversationId).catch(() => null));
        plan = mediaResendPlan(await recentMediaDeliveries(input.conversationId, since).catch(() => []), config);
      }
      if (plan?.resend) {
        outboundActions = outboundActions.map((a) =>
          a.type === "send_message_model" && alreadySent.has(a.modelId as string) ? ({ ...a, mediaOnly: true } as V2Action) : a,
        );
        replyText = plan.reply;
        traceStep("mídia", plan.trace);
      } else {
        outboundActions = outboundActions.filter((a) => !(a.type === "send_message_model" && alreadySent.has(a.modelId as string)));
        traceStep("ações", `Mensagem pronta já enviada nesta conversa há pouco — não reenviada (${[...alreadySent].join(", ")})`);
        if (plan) {
          replyText = plan.reply;
          traceStep("mídia", plan.trace);
          if (plan.handoff) {
            wantsHandoff = true;
            noteV2Fact("handoffCause", "media_failed", { keepFirst: true });
          }
        } else if (!outboundActions.some((a) => a.type === "send_message_model") && replyText.trim().split(/\s+/).length <= 30) {
          // Resposta que só apresentava o material vira o aviso de que ele está acima.
          replyText = systemMessage(config, "materialAlreadySent");
        }
      }
    }
  }
  // Resposta longa + mensagem pronta escolhida pelo modelo:
  // - a mensagem pronta traz o que a resposta explica → a resposta vira só a
  //   introdução (o cliente não lê o mesmo conteúdo duas vezes);
  // - traz outra coisa (ou é só arquivo) → saem as duas: a resposta completa e,
  //   depois, a mensagem pronta. Antes a resposta virava "Faça assim:" com um
  //   conteúdo que não era o pedido; depois a mensagem pronta era descartada e
  //   o vídeo configurado não chegava.
  // O administrador escolhe o que vale (Mensagens prontas › quando também há
  // material; exceção por assunto): automático, as duas, só uma ou combinar.
  const mmMode = messageModelModeFor(config, themeId);
  if (messageModelFilesOnly(mmMode) && outboundActions.some((a) => a.type === "send_message_model")) {
    outboundActions = outboundActions.map((a) =>
      a.type === "send_message_model" && (a as { mediaOnly?: unknown }).mediaOnly !== true ? ({ ...a, filesOnly: true } as V2Action) : a,
    );
    traceStep("ações", mmMode === "combine"
      ? "Mensagem pronta combinada na resposta; dela seguem só os arquivos"
      : "Modo “só a resposta”: da mensagem pronta seguem só os arquivos");
  }
  let messageModelCoversReply = mmMode === "message_model";
  if (mmMode === "auto" && replyText.trim().split(/\s+/).length > 40) {
    const modelActions = outboundActions.filter(
      (a) => a.type === "send_message_model" && typeof a.modelId === "string" && (a as { mediaOnly?: unknown }).mediaOnly !== true,
    );
    if (modelActions.length > 0) {
      const rows = await Promise.resolve()
        .then(() =>
          prisma.messageTemplate.findMany({
            where: { id: { in: modelActions.map((a) => a.modelId as string) }, organizationId: orgId },
            select: { id: true, name: true, content: true },
          }),
        )
        .catch(() => [] as Array<{ id: string; name: string; content: string | null }>);
      messageModelCoversReply = (rows ?? []).some(
        (r) => (r.content ?? "").trim() && messageModelCoverage(replyText, r.content ?? "") >= MESSAGE_MODEL_MIN_COVERAGE,
      );
      if (!messageModelCoversReply && (rows ?? []).length > 0) {
        traceStep("ações", `Mensagem pronta ${(rows ?? []).map((r) => `"${r.name}"`).join(", ")} traz outro conteúdo — vai a resposta completa e, em seguida, a mensagem pronta`);
      }
    }
  }
  // Anexo de material que já saiu dentro da trava dele: não sai de novo, e a
  // resposta não pode dizer "segue o vídeo" sem nada chegar.
  const requestedAttachmentIds = [...new Set(outboundActions
    .filter((a) => a.type === "send_material_attachment")
    .flatMap((a) => (Array.isArray((a as { attachmentIds?: unknown }).attachmentIds) ? (a as unknown as { attachmentIds: unknown[] }).attachmentIds : []))
    .filter((x): x is string => typeof x === "string"))];
  if (requestedAttachmentIds.length > 0 && input.conversationId) {
    const blocked = await attachmentsBlockedByResend(resolved!.agentConfigId, input.conversationId, requestedAttachmentIds).catch(() => new Set<string>());
    if (blocked.size > 0) {
      outboundActions = outboundActions
        .map((a) => a.type === "send_material_attachment"
          ? ({ ...a, attachmentIds: ((a as { attachmentIds?: string[] }).attachmentIds ?? []).filter((id) => !blocked.has(id)) } as V2Action)
          : a)
        .filter((a) => a.type !== "send_material_attachment" || ((a as { attachmentIds?: string[] }).attachmentIds ?? []).length > 0);
      traceStep("mídia", `Anexo(s) já enviado(s) nesta conversa dentro da trava de repetição — não reenviado(s) (${[...blocked].join(", ")})`);
      const nothingFollows = !outboundActions.some((a) => a.type === "send_message_model" || a.type === "send_material_attachment");
      if (nothingFollows && announcesSending(replyText)) {
        replyText = replyText.trim().split(/\s+/).length <= 30 ? systemMessage(config, "materialAlreadySent") : `${replyText.trim()}\n\n${systemMessage(config, "attachmentAbove")}`;
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
  if (actionRes.results.some((r) => r.ok && ["send_message_model", "send_product", "send_material_attachment"].includes(r.action.type))) {
    counters.guidanceGiven = true;
  }
  Object.assign(collectedVariables, variablesFromActions(actionRes.results));
  anyHandoff = wantsHandoff;
  // O modelo só encerra com confirmação explícita do cliente ("resolvido",
  // "não preciso de mais nada") ou clique num botão. "Ok" / "certo" / 👍
  // depois de uma orientação é confirmação de leitura: encerrar aí deixava o
  // cliente que voltava com a dúvida um minuto depois sem agente e com os
  // botões "mortos". Quem encerra esse caso é a inatividade.
  if (llmOutput.concluded && !actionRes.anyClose && !chosenOption && isShortAckText(input.userMessage) && !isExplicitResolution(input.userMessage)) {
    traceStep("encerramento", "Modelo quis encerrar após confirmação curta (\"ok\") → segue aberto; a inatividade encerra se o cliente não voltar");
    llmOutput.concluded = false;
  }
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
  // Fora do escopo: o limite do início do turno usa o contador antes desta
  // mensagem. Reavalia com o contador novo — o aviso saía duas vezes, e um
  // cliente que voltou ao assunto ficava sem resposta.
  let stopLimits = stop.blocksReply && stop.reason !== NONSENSE_LIMIT_REASON
    ? stop
    : evaluateV2StopLimits(config, counters, input.userMessage, { countLoop: false });
  // Pergunta com conteúdo e o modelo respondeu: a resposta vale mais que o
  // aviso de loop. O aviso é para mensagem curta/sem sentido repetida; uma
  // pergunta real repetida é sinal de que o cliente ainda não teve resposta.
  if (
    stopLimits.blocksReply &&
    stopLimits.reason === "loop detectado" &&
    replyText.trim() &&
    input.userMessage.includes("?") &&
    hasSearchableQuestion(input.userMessage)
  ) {
    traceStep("limites", "Mensagem repetida é uma pergunta com conteúdo e o modelo respondeu → a resposta sai no lugar do aviso de loop");
    counters.loopCount = 0;
    counters.lastLoopMessage = undefined;
    stopLimits = { blocksReply: false, action: "none", reason: "" };
  }
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
  const materialFollows = !stopLimits.blocksReply && outboundActions.some((a) => a.type === "send_message_model" || a.type === "send_product" || a.type === "send_material_attachment");
  // A mensagem "sem material" não ganha fecho ("Posso ajudar em algo mais?"
  // colado em "não tenho essa informação").
  // Transferência condicional ("se continuar diferente, encaminho"): a resposta
  // já termina pedindo que o cliente confira e volte; o fecho de passo a passo
  // com "Deu certo / Preciso de ajuda" contradizia o "posso encaminhar".
  // Cortesia ("ok", "obrigado") não ganha "posso ajudar em mais alguma
  // coisa?" com botões: o cliente acabou de dizer que não precisa.
  if (replyText.trim() && classifyReply(replyText) === "procedure") counters.guidanceGiven = true;
  const courtesyInbound = isShortAckText(input.userMessage);
  const endingAllowed = !anyHandoff && !anyClose && askOptions.length === 0 && (stage as V2Stage) !== "confirming" && !llmOutput.outOfScope && !noSourceApplied && !conditionalWait && !courtesyInbound;
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

  // Resposta vazia do modelo (sem transferir, encerrar, material ou botões):
  // o cliente ficava sem nada. Pergunta o que ele precisa.
  if (!anyHandoff && !anyClose && !replyText.trim() && outboundActions.length === 0 && replyOptions.length === 0 && !stopLimits.blocksReply) {
    replyText = repeatFallback(lastAgentMessage, config);
    traceStep("resposta", "O modelo devolveu uma resposta vazia → pede ao cliente que diga o que precisa");
  }

  // Saudação que ficou para trás: o cliente mandou "Oi" e logo o pedido, e o
  // pedido chegou enquanto este turno pensava. Mandar "Como posso ajudar?"
  // depois do pedido parece que o agente não leu; o próximo turno responde.
  const greetingOnlyReply =
    !anyHandoff &&
    !anyClose &&
    replyOptions.length === 0 &&
    outboundActions.length === 0 &&
    isGreetingOnlyReply(replyText);
  // Pergunta (com ou sem botões) só sai se o cliente não escreveu nada
  // enquanto o agente pensava. Se escreveu — muitas vezes é a resposta à
  // própria pergunta, clicada numa versão anterior —, o turno seguinte
  // decide com tudo em mãos. Antes a pergunta saía em dobro e o cliente
  // respondia às duas.
  // Só PERGUNTA DE TRIAGEM espera (curta, ou com os botões que o modelo
  // pediu). Resposta com conteúdo sai sempre, mesmo que o fecho diga "me
  // avise se deu certo" ou "posso ajudar em mais alguma coisa?" — a versão
  // anterior contava o fecho como pergunta e descartava respostas inteiras
  // quando o cliente mandava um "ok" no meio.
  const coreReply = withoutReplyEndings(replyText, replyEndingPhrases(config)).trim();
  const isTriageQuestion =
    askOptions.length > 0 ||
    (asksClient(coreReply) && coreReply.split(/\s+/).length <= 40 && classifyReply(coreReply) !== "procedure");

  // Trocas sem avanço: o agente respondeu só com outra pergunta (sem
  // orientação, material, ação nem dado coletado) a uma mensagem que não
  // era pergunta — o cliente respondeu e ele insistiu. Passado o limite
  // configurado, a próxima pergunta não sai: a conversa segue pela saída
  // do assunto (destino escolhido) ou encerra. Pergunta de esclarecimento
  // a uma pergunta do cliente não conta; orientação ou dado novo zera.
  if (themeId && themeId !== (stateRow?.themeId ?? undefined)) counters.stalledExchanges = 0;
  const probingOnly =
    !anyHandoff && !anyClose && !stopLimits.blocksReply && replyText.trim().length > 0 &&
    (askOptions.length > 0 || coreReply.trimEnd().endsWith("?")) &&
    classifyReply(coreReply) !== "procedure" &&
    !materialFollows && outboundActions.length === 0 &&
    Object.keys(llmOutput.collected ?? {}).length === 0;
  if (probingOnly && !asksClient(input.userMessage)) {
    if (shouldStopStalled(config, counters)) {
      const stalledAction = config.limits.stalledExchangesAction;
      traceStep("limites", `Limite de trocas sem avanço: ${counters.stalledExchanges} pergunta(s) seguida(s) sem resolver → ${stalledAction === "close" ? "encerra" : "sai pela saída do assunto, sem insistir"}`);
      counters.stalledExchanges = 0;
      replyText = "";
      replyOptions = [];
      if (stalledAction === "close") {
        anyClose = true;
        llmOutput.concluded = true;
      } else {
        anyHandoff = true;
        llmOutput.handoff = true;
        noteV2Fact("handoffCause", "limit", { keepFirst: true });
      }
    } else {
      counters.stalledExchanges += 1;
    }
  } else if (!probingOnly) {
    counters.stalledExchanges = 0;
  }
  const asksSomething = !anyHandoff && !anyClose && !stopLimits.blocksReply && isTriageQuestion;
  if ((greetingOnlyReply || asksSomething) && (await newerInboundArrived(input.conversationId, input.messageIds))) {
    traceStep("resposta", greetingOnlyReply
      ? "O cliente já mandou outra mensagem; a saudação não sai — a próxima resposta cobre as duas"
      : "O cliente já mandou outra mensagem enquanto o agente pensava; a pergunta não sai — o próximo turno decide com tudo em mãos");
    replyText = "";
    replyOptions = [];
  }

  // Mensagem pronta a seguir: a resposta só apresenta. Resposta completa +
  // mensagem pronta (adaptada) mandava o mesmo conteúdo duas vezes.
  if (!anyHandoff && messageModelCoversReply && outboundActions.some((a) => a.type === "send_message_model") && replyText.trim().split(/\s+/).length > 40) {
    const intro = introBeforeMaterial(replyText);
    traceStep("resposta", intro ? `Mensagem pronta a seguir: a resposta vira só a introdução (“${intro.slice(0, 80)}”)` : "Mensagem pronta a seguir: a resposta completa não sai (o material já responde)");
    replyText = intro;
  }

  // Envia reply se houver e não for handoff/close
  if (!anyHandoff && !anyClose && replyText.trim()) {
    const withOptions = replyOptions.length > 0 ? buildV2Interactive(replyText, replyOptions, optionTexts) : null;
    const outText = withOptions ? withOptions.fallbackText : replyText;
    // A saudação é conferida de novo depois do "digitando…".
    const res = await sendReply(outText, withOptions?.payload, { dropIfSuperseded: greetingOnlyReply || asksSomething });
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
      // A saída se mede também pela resposta barrada (sem o fecho): ela
      // repetia uma explicação, mesmo quando a mensagem anterior era só uma
      // pergunta curta — e "me conta o que você precisa" chegava logo depois
      // de o cliente dizer o que precisava.
      const blocked = withoutReplyEndings(replyText, replyEndingPhrases(config));
      const basis = blocked.length > (lastAgentMessage ?? "").length ? blocked : lastAgentMessage;
      const fallback = repeatFallback(basis, config);
      const clientSaidSomething =
        !chosenOption && !isFillerMessage(input.userMessage) && !isShortAckText(input.userMessage) && !isGreetingOnlyMessage(input.userMessage);
      const nothingToSay = fallback === systemMessage(config, "stillHere");
      if (clientSaidSomething && nothingToSay && !anyHandoff && !anyClose) {
        // O cliente disse o que precisa e o agente só repetiria a pergunta:
        // "Estou por aqui! Me conta o que você precisa" em cima disso é
        // surdez. Sai pela saída do assunto (ou encerra), como no limite de
        // trocas sem avanço, com o contexto. Explicação repetida continua
        // com "ficou alguma dúvida sobre o que te passei?".
        const stalledAction = config.limits.stalledExchangesAction;
        traceStep("resposta", `Só repetiria a pergunta depois de o cliente dizer o que precisa → ${stalledAction === "close" ? "encerra" : "transfere pela saída do assunto, com o contexto"}`);
        if (stalledAction === "close") {
          anyClose = true;
          llmOutput.concluded = true;
        } else {
          anyHandoff = true;
          llmOutput.handoff = true;
          noteV2Fact("handoffCause", "limit", { keepFirst: true });
        }
      } else {
        const alt = await sendReply(fallback);
        if (alt.sent) sentReply = fallback;
      }
    }
    // Não enviada fica fora do log do turno: antes o log dizia que o agente
    // respondeu e o cliente não tinha recebido nada.
  }

  // Mensagens prontas/produtos/modelos: depois da reply. Não saem quando o
  // turno transfere ou quando um limite de parada bloqueou a resposta.
  if (outboundActions.length > 0 && !anyHandoff && !stopLimits.blocksReply && !humanTookOver) {
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
    // "Só a resposta"/"combinar": da mensagem pronta saíram só arquivos; o fecho
    // vem depois deles, pelo tipo da resposta (antes ficava sem fecho nem botões).
    const filesOnlySent = outRes.results.some((r) => r.ok && r.action.type === "send_message_model" && (r.action as { filesOnly?: unknown }).filesOnly === true);
    if (endingAllowed && materialFollows && !anyHandoff && (material.trim() || filesOnlySent)) {
      // O tipo de fecho vem do conjunto que o cliente recebeu (a introdução
      // "siga as instruções abaixo" + a mensagem pronta), não só do texto dela.
      const ending = applyReplyEnding({
        reply: material.trim() ? material : replyText,
        ending: effectiveReplyEnding(config, activeTheme),
        lastAgentMessage: material.trim() ? replyText : null,
        turnSeed: historyLength,
        kindFrom: `${replyText}\n\n${material}`,
      });
      if (ending.added) {
        const buttons = replyEndingButtons(effectiveReplyEnding(config, activeTheme), ending.kind);
        const built = buttons.length > 0 ? buildV2Interactive(ending.added, buttons, optionTexts) : null;
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
    const cause = peekV2Fact("handoffCause");
    // Um caminho só de mensagem: explicação curta do modelo (sem as frases
    // que avisam a transferência) + mensagem configurada. O "não encontrei
    // resposta segura" fica só quando não há resposta validada nenhuma
    // (a checagem barrou ou nada nos materiais cobre a mensagem). Antes a
    // mesma situação saía de três jeitos diferentes.
    const fallbackOnly = cause === "verification" || cause === "no_source";
    const noSourceMsg = fallbackOnly ? config.fallback?.noSource?.message?.trim() ?? "" : "";
    // Só quando a resposta do modelo é uma explicação de verdade (transferiu
    // por decisão, cliente irritado, anexo que não chega, pedido de pessoa);
    // "segue o material:" de uma mensagem pronta barrada não é explicação.
    const explains = cause === "model" || cause === "sentiment" || cause === "media_failed" || cause === "human_request";
    const explanation = explains && !fallbackOnly && !waitingInQueue ? handoffExplanation(replyText) : "";
    if (explanation) {
      const answered = await sendReply(explanation);
      if (answered.sent) {
        sentReply = explanation;
        traceStep("resposta", cause === "sentiment"
          ? "Cliente irritado: responde antes de transferir"
          : cause === "media_failed"
            ? "Explica que o anexo não está chegando e chama a equipe"
            : "Explica antes de transferir; a mensagem configurada vem em seguida");
        // Os anexos do material (vídeo, imagem…) acompanham a orientação.
        const attachments = cause === "model" ? outboundActions.filter((a) => a.type === "send_material_attachment") : [];
        if (attachments.length > 0 && !stopLimits.blocksReply) {
          const attRes = await executeV2Actions(attachments, actionCtx);
          executedActions = [...executedActions, ...attRes.results];
          traceStep("mídia", attRes.results.some((r) => r.ok) ? "Anexo enviado junto da orientação, antes de transferir" : "Anexo não enviado antes de transferir");
        }
      }
    }
    // Já estava na fila: o aviso é o de fila (a transferência de novo só redistribui).
    const queuedMsg = waitingInQueue ? queuedMessageFor(config.handoff.queuedMessage, isWithinV2BusinessHours(config), systemMessage(config, "queueOutsideHours")) : "";
    const handoffNote = queuedMsg || noSourceMsg;
    const hoursNote = outsideHoursNote(config);
    const sent = await performHandoff(
      requestedDestination ?? activeTheme?.handoffDestination,
      handoffNote || hoursNote
        ? { message: [handoffNote || renderMessage((requestedDestination ?? activeTheme?.handoffDestination)?.message?.trim() || config.handoff.message, vars, defaultFormatter()), hoursNote].filter(Boolean).join("\n\n") }
        : {},
    );
    if (sent) sentReply = sentReply ? `${sentReply}\n${sent}`.trim() : sent;
    owner = "pessoa";
  }

  // Encerramento
  if (anyClose) {
    const goodbye = config.closure.goodbyeMessage;
    if (goodbye && !anyHandoff) {
      const goodbyeRendered = renderMessage(goodbye, vars, defaultFormatter());
      if ((await sendReply(goodbyeRendered)).sent) sentReply = goodbyeRendered;
    } else if (!anyHandoff && replyText.trim()) {
      // Sem despedida configurada, sai a resposta do modelo ("Combinado!
      // Qualquer coisa, é só chamar."). Antes era descartada e o cliente
      // ficava sem nada, com o atendimento encerrado.
      if ((await sendReply(replyText)).sent) sentReply = replyText;
      traceStep("encerramento", "Sem despedida configurada → envia a resposta do modelo e encerra");
    }
    await closeState(orgId, input.conversationId, resolved!.agentConfigId, loadedContext.dealId, config, versionId, llmOutput.concluded ? "resolved" : "transferred", loadedContext.contactId, collectedVariables, activeTheme);
  } else {
    if (summaryEnabled(config)?.everyTurn && sentReply && !anyHandoff) {
      const running = await updateRunningSummary({ conversationId: input.conversationId, agentId: resolved!.agentConfigId, config });
      if (running) {
        counters.runningSummary = running;
        traceStep("resumo", "Resumo corrente atualizado");
      }
    }
    // Atualiza estado
    await upsertV2ConversationState({
      organizationId: orgId,
      conversationId: input.conversationId,
      agentId: resolved!.agentConfigId,
      stage: anyHandoff ? stage : "active",
      themeId,
      owner: humanTookOver ? "pessoa" : owner,
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
    const planned = resolveHandoffDestination(config, requested ?? config.handoff.defaultDestination, counters, resolved!.agentConfigId);
    // Transferência entre agentes de IA em modo transparente (opção em
    // qualquer um dos dois): o cliente não percebe a troca — sem "vou te
    // passar para…"; o outro agente responde direto.
    if (!opts.skipMessage && planned.type === "ai_agent" && planned.id) {
      const who = config.entry.onAiTransfer === "continue" ? "Este agente" : (await aiAgentReceivesTransparently(planned.id)) ? "Agente de destino" : null;
      if (who) {
        traceStep("transferência", `${who} em modo transparente → sem aviso de transferência`);
        opts = { ...opts, skipMessage: true };
      }
    }
    // Transferência em cadeia: recebeu de outro agente e transfere de novo
    // no primeiro turno sem ter respondido nada. O aviso do agente anterior
    // ("vou te passar para…") já cobriu — repetir soa como ninguém atender.
    // Se o anterior foi transparente (sem aviso), este aviso sai.
    if (!opts.skipMessage && handedByAnotherAgent && !sentReply && (await inboundAlreadyAnswered(input.conversationId, input.messageIds))) {
      traceStep("transferência", "Transferência em cadeia logo após receber a conversa: o aviso do agente anterior já cobriu → sem novo aviso");
      opts = { ...opts, skipMessage: true };
    }
    if (!opts.skipMessage) {
      // Mensagem do destino (assunto/regra) quando configurada; a tela já
      // tinha o campo, mas valia sempre a mensagem padrão.
      const destinationMessage = typeof requested?.message === "string" ? requested.message.trim() : "";
      const handoffMsg = renderMessage(opts.message || destinationMessage || config.handoff.message, vars, defaultFormatter());
      // O aviso de transferência nunca passa pelo guarda de repetição: o
      // agente anterior (ou este, minutos antes) pode ter mandado o mesmo
      // texto ao transferir, e o cliente ficava sem saber que mudou de mão.
      if (handoffMsg.trim()) {
        const res = await sendReply(handoffMsg, null, { bypassDuplicateGuard: true });
        if (res.sent) sent = handoffMsg;
        else traceStep("transferência", `Aviso de transferência não saiu (${res.reason ?? "motivo desconhecido"})`);
      }
    }
    // Uma pessoa assumiu durante o turno (ou outro processo retomou o turno):
    // transferir agora tiraria a conversa de quem já está atendendo.
    if (humanTookOver || !(await ownsTurn()) || !(await assignedToAgent(input.conversationId, resolved!.userId))) {
      traceStep("transferência", humanTookOver ? "Uma pessoa assumiu a conversa durante o turno → sem transferência" : "A conversa não está mais com o agente → sem transferência");
      humanTookOver = true;
      return sent;
    }
    const destination = planned;
    if (destination.type === "ai_agent") counters.aiTransferCount += 1;
    const tabulation = await applyV2Tabulation({ config, theme: getV2ThemeById(config, themeId), moment: "transfer", organizationId: orgId, conversationId: input.conversationId, contactId, agentId: resolved!.agentConfigId });
    await summarizeBeforeHandoff(destination, tabulation);
    await simpleHandoff({
      conversationId: input.conversationId,
      contactId,
      dealId: loadedContext.dealId,
      destination,
      turnId: input.turnId,
    });
    traceStep("transferência", `Transferido para ${destination.type}${destination.id ? ` (${destination.id})` : ""}`);
    return sent;
  }

  async function sendReply(
    text: string,
    interactive?: V2InteractivePayload | null,
    opts?: { dropIfSuperseded?: boolean; bypassDuplicateGuard?: boolean },
  ): Promise<{ sent: boolean; reason?: string }> {
    if (!text.trim()) return { sent: false, reason: "empty" };
    if (humanTookOver) return { sent: false, reason: "human_took_over" };
    if (!(await ownsTurn())) {
      traceStep("resposta", "Turno retomado por outro processo (passou do teto de tempo) → esta execução não envia mais nada");
      return { sent: false, reason: "turn_reclaimed" };
    }
    const res = await sendV2TextMessage({
      interactive,
      conversationId: input.conversationId,
      contactId: contactId!,
      agentUserId: resolved!.userId,
      text,
      dedupeIgnore: replyEndingPhrases(config),
      ...(opts?.bypassDuplicateGuard ? { bypassDuplicateGuard: true } : {}),
      channel: input.channel,
      autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
      humanBehavior: opts?.dropIfSuperseded
        ? { ...humanBehavior, abortIf: () => newerInboundArrived(input.conversationId, input.messageIds) }
        : humanBehavior,
    });
    if (!res.sent && res.reason && HUMAN_TOOK_OVER.has(res.reason)) {
      humanTookOver = true;
      traceStep("resposta", "Uma pessoa assumiu a conversa durante o turno → o agente para por aqui (sem transferência nem materiais)");
    }
    return res;
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
  humanRequestWithQuestion = false,
  priorSummary: Awaited<ReturnType<typeof loadPriorV2Summary>> = null,
  transparentTransfer = false,
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
  let themeInstructions = theme
    ? themePromptText(theme)
    : undefined;
  if (config.useDispatchText) {
    const dispatch = await loadLastCampaignDispatchContext(input.conversationId, null, { chatOnly: true }).catch(() => null);
    const block = formatCampaignDispatchBlock(dispatch);
    if (block) themeInstructions = [themeInstructions, block].filter(Boolean).join("\n");
  }

  const previousMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  // Carrega últimas mensagens do histórico
  try {
    const rows = await (prisma as unknown as {
      message: {
        findMany: (args: { where: Record<string, unknown>; orderBy: { createdAt: "desc" }; take: number; select: Record<string, boolean> }) => Promise<Array<{ id: string; direction: string; content: string; authorType: string; messageType: string; organizationId: string; templateConfigId: string | null; senderName: string | null }>>;
      };
    }).message.findMany({
      where: { conversationId: input.conversationId, messageType: { not: "note" }, isPrivate: false },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, direction: true, content: true, authorType: true, messageType: true, organizationId: true, templateConfigId: true, senderName: true },
    });
    // Áudio/imagem já entendidos entram com o conteúdo, não com "[Áudio]".
    const mediaRows = rows.filter((m) => m.direction === "in" && understoodKindOf(m.messageType));
    const mediaTexts = mediaRows.length > 0 ? await getMediaTexts(mediaRows[0].organizationId, mediaRows.map((m) => m.id)) : new Map<string, string>();
    for (const m of rows.reverse()) {
      const role = m.direction === "out" || m.authorType === "bot" ? "assistant" : "user";
      const kind = understoodKindOf(m.messageType);
      const understood = kind ? mediaTexts.get(m.id) : undefined;
      let content = understood && kind ? mediaTextLine(kind, understood, m.content) : m.content ?? "";
      if (config.useDispatchText && role === "assistant") {
        content = await hydrateOutboundTemplateContent({
          content,
          messageType: m.messageType,
          templateConfigId: m.templateConfigId,
          senderName: m.senderName,
        });
      }
      previousMessages.push({ role, content });
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
      priorSummary,
      agentId: resolved!.agentConfigId,
      config,
      context,
      userMessage: input.userMessage,
      stage,
      themeId,
      themeInstructions,
      collectedVariables,
      previousMessages,
      humanRequestWithQuestion,
      transparentTransfer,
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
  const res = await sendV2TextMessage({
    conversationId: input.conversationId,
    contactId,
    agentUserId: resolved!.userId,
    text: message,
    channel: input.channel,
    autonomyMode: mapV2AutonomyToPrisma(config.autonomyMode),
    humanBehavior: v2HumanBehavior(config),
    // Aviso de transferência: nunca barrado como repetido.
    bypassDuplicateGuard: true,
  });
  // Uma pessoa assumiu a conversa enquanto isso: sem transferência.
  if ((!res.sent && res.reason && HUMAN_TOOK_OVER.has(res.reason)) || !(await assignedToAgent(input.conversationId, resolved.userId))) {
    traceStep("transferência", "Uma pessoa assumiu a conversa durante o turno → sem transferência");
    await upsertV2ConversationState({ organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, owner: "pessoa", counters: counters as V2Counters, versionId, ...(themeId ? { themeId } : {}) });
    await logV2Turn({
      organizationId: orgId, conversationId: input.conversationId, agentId: resolved!.agentConfigId, turnId: input.turnId,
      inboundText: input.userMessage,
      crmContext: { contact: loadedContext.contact, contactRaw: loadedContext.contactRaw, deals: loadedContext.deals, selectedDeal: loadedContext.selectedDeal, fields: config.contextFields },
      themeId, prompt: "handoff", executedActions: [], discardedActions: [{ type: "handoff", reason: "human took over" } as any],
      handoff: false, latencyMs: 0, inputTokens: 0, outputTokens: 0, owner: "pessoa", stage: (stateRow?.stage as V2Stage) ?? "idle", versionId,
    });
    return;
  }
  const fallbackDestination = resolveHandoffDestination(config, config.handoff.defaultDestination, counters, resolved.agentConfigId);
  if (fallbackDestination.type === "ai_agent") counters.aiTransferCount += 1;
  traceStep("transferência", `Transferido para ${fallbackDestination.type}${fallbackDestination.id ? ` (${fallbackDestination.id})` : ""}`);
  const tabulation = await applyV2Tabulation({ config, theme: getV2ThemeById(config, themeId), moment: "transfer", organizationId: orgId, conversationId: input.conversationId, contactId, agentId: resolved!.agentConfigId });
  await writeV2Summary({ organizationId: orgId, conversationId: input.conversationId, contactId, agentId: resolved.agentConfigId, config, moment: "transfer", reason: fallbackDestination.type, tabulation });
  await simpleHandoff({
    conversationId: input.conversationId,
    contactId,
    dealId: loadedContext.dealId,
    destination: fallbackDestination,
    turnId: input.turnId,
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
    log.error({ err }, "[ai-v2] createInitialDeal falhou");
    return null;
  }
}

/** Chave da org: encerramento pelo agente dispara fluxos "Conversa encerrada"? Padrão: não. */
export const RUN_FLOWS_ON_AI_CLOSE_KEY = "automations.runOnAiClose";

/**
 * Fluxos "Conversa encerrada" são do encerramento humano/por fluxo. O agente
 * tem o próprio pós-encerramento (cortesia, retorno, nova demanda) e os
 * fluxos disputavam a conversa: tiravam o agente, moviam etapa, ficavam
 * esperando resposta. Ligar na org quando houver fluxo pós-atendimento
 * pensado para o agente.
 */
async function flowsOnAiClose(): Promise<boolean> {
  try {
    const { getOrgSettingBool } = await import("@/lib/org-settings");
    return await getOrgSettingBool(RUN_FLOWS_ON_AI_CLOSE_KEY, false);
  } catch {
    return false;
  }
}

export async function closeState(
  orgId: string,
  conversationId: string,
  agentConfigId: string,
  dealId: string | undefined,
  config: V2AgentConfig,
  versionId: string | undefined,
  reason: string,
  contactId?: string,
  collectedVariables?: Record<string, unknown>,
  theme?: V2Theme | null,
): Promise<void> {
  // Tabulação (se ligada) antes de resolver: o encerramento não sobrescreve.
  // E antes do resumo: a folha escolhida entra nele.
  const tabulation = await applyV2Tabulation({ config, theme, moment: "close", organizationId: orgId, conversationId, contactId, agentId: agentConfigId });
  // Resumo para a equipe (quando ligado), com a conversa ainda inteira.
  await writeV2Summary({ organizationId: orgId, conversationId, contactId, agentId: agentConfigId, config, moment: "close", reason, tabulation });
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
    skipAutomations: !(await flowsOnAiClose()),
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
