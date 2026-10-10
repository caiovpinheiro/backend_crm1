import { isAckOrGreetingText } from "@/lib/ai-agents/tabulation-classify-policy";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  isReplaySandboxActive,
  recordBlockedEffect,
} from "@/services/ai/replay-sandbox";
import { getOrgIdOrNull } from "@/lib/request-context";
import { getActiveContext } from "@/services/automation-context";
import {
  loadIntentionalStageClusterIds,
  shouldSkipIntentionalStageRetrigger,
} from "@/services/intentional-stage-cluster";

import {
  enqueueAutomation,
  evaluateTrigger,
  type AutomationJobContext,
} from "@/services/automations";
import {
  dispatchIntegrationWebhooks,
  hasIntegrationWebhooks,
} from "@/services/integration-webhooks";
import { getLogger } from "@/lib/logger";

const log = getLogger("automation-triggers");

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function readStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** Mesma regra de `readTriggerStageIds` em automations.ts. Local para o teste que mocka esse módulo. */
function triggerStageIds(cfg: Record<string, unknown>): string[] {
  const many = readStringArray(cfg, "stageIds");
  if (many.length > 0) return many;
  const one = readString(cfg, "stageId");
  return one ? [one] : [];
}

/**
 * Mensagem com vários negócios do mesmo contato.
 * Com filtro de funil/etapa/status, o conjunto é quem casa o filtro.
 * Sem filtro, um único OPEN segue. Vários OPEN não elegem card.
 */
export function classifyMessageDeals(args: {
  filterActive: boolean;
  matchedIds: string[];
  openIds: string[];
}):
  | { mode: "matched"; dealId: string; matchedIds: string[] }
  | { mode: "single-open"; dealId: string }
  | { mode: "ambiguous" }
  | { mode: "no-open" }
  | { mode: "filter-miss" } {
  if (args.filterActive) {
    if (args.matchedIds.length === 0) return { mode: "filter-miss" };
    return {
      mode: "matched",
      dealId: args.matchedIds[0]!,
      matchedIds: args.matchedIds,
    };
  }
  if (args.openIds.length > 1) return { mode: "ambiguous" };
  if (args.openIds.length === 1) {
    return { mode: "single-open", dealId: args.openIds[0]! };
  }
  return { mode: "no-open" };
}

/**
 * Payload padrão dos gatilhos `message_received` / `message_sent`.
 * Sem `channelId` + `conversationId`, o filtro por conexão da org não casa.
 */
export function buildMessageTriggerData(args: {
  channel: string;
  channelId?: string | null;
  conversationId?: string | null;
  content?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    channel: args.channel,
    ...(args.channelId ? { channelId: args.channelId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.content !== undefined ? { content: args.content } : {}),
    ...args.extra,
  };
}

/**
 * Primeiro inbound do ticket novo. O canvas lê `data.content` /
 * `data.isAckOrGreeting` no passo Condição; o gatilho pode optar por
 * `skipIfAckOrGreeting` (default off).
 */
export function openingMessageTriggerExtra(args: {
  content?: string | null;
  messageType?: string | null;
}): Record<string, unknown> {
  const content = (args.content ?? "").trim();
  const messageType = (args.messageType ?? "").trim();
  return {
    ...(content ? { content } : {}),
    ...(messageType ? { messageType } : {}),
    isAckOrGreeting: isAckOrGreetingText(content),
  };
}

/**
 * Ticket novo. `conversation_created` NÃO é silenciado por assignee IA/humano
 * — senão o inbound do WhatsApp nunca aciona fluxos tipo "inicio - pipe"
 * (o webhook só disparava `message_received`, e esse sim é suprimido).
 */
export function emitConversationCreated(args: {
  contactId: string;
  channel: string;
  channelId?: string | null;
  conversationId?: string | null;
  source: string;
  extra?: Record<string, unknown>;
}): void {
  const data = {
    channel: args.channel,
    source: args.source,
    ...(args.channelId ? { channelId: args.channelId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...args.extra,
  };
  void (async () => {
    try {
      const { maybeResolveIdleReopenTicket } = await import(
        "@/services/ai/idle-inbound"
      );
      const content =
        typeof data.content === "string"
          ? data.content
          : typeof data.text === "string"
            ? data.text
            : null;
      const messageType =
        typeof data.messageType === "string" ? data.messageType : null;
      await maybeResolveIdleReopenTicket({
        conversationId: args.conversationId,
        contactId: args.contactId,
        content,
        messageType,
      });
    } catch {
      /* best-effort */
    }
    await fireTrigger("conversation_created", {
      contactId: args.contactId,
      data,
    });
  })().catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "Falha no gatilho conversation_created",
    );
  });
}

/** Comparação frouxa (trim + case-insensitive) usada nas condições de campo. */
function looseEquals(a: unknown, b: unknown): boolean {
  const sa = String(a ?? "").trim().toLowerCase();
  const sb = String(b ?? "").trim().toLowerCase();
  return sa === sb;
}

/** Chaves nativas de contato/negócio aceitas pela condição "campo". */
const NATIVE_CONTACT_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "source",
  "lifecycleStage",
  "assignedToId",
  // Informação rastreada — condição "campo" no trigger do pipeline
  "adUtmSource",
  "adUtmMedium",
  "adUtmCampaign",
  "adUtmContent",
  "adUtmTerm",
  "utmId",
  "utmReferrer",
  "referrer",
  "gclid",
  "fbclid",
  "googleClientId",
  "ttadId",
  "ttadName",
]);
const NATIVE_DEAL_FIELDS = new Set(["title", "value", "status", "stageId"]);

/**
 * Avalia as condições extras salvas em `triggerConfig.conditions` (Tag /
 * Campo / Canal) com semântica **E** (todas precisam bater). Configuradas
 * no drawer de automação do pipeline ("Para todos os leads com").
 *
 * Fail-closed: se uma condição depende de dados que não conseguimos
 * resolver (ex.: sem contato) ela NÃO passa — o operador filtrou de
 * propósito, então na dúvida não dispara.
 *
 * Carrega dados sob demanda (tags/campos/canais) e só o necessário pras
 * condições presentes, com cache local à chamada. Nunca lança.
 */
export async function evaluateTriggerConditions(
  triggerConfig: unknown,
  context: { contactId?: string; dealId?: string; data?: unknown },
): Promise<boolean> {
  const cfg = asRecord(triggerConfig);
  const rawConditions = cfg ? cfg.conditions : undefined;
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) return true;

  try {
    const data = asRecord(context.data) ?? {};

    // Resolve contactId/dealId (o negócio pode não trazer o contato no payload).
    let contactId = context.contactId;
    let dealId = context.dealId;
    if (!contactId && dealId) {
      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        select: { contactId: true },
      });
      contactId = deal?.contactId ?? undefined;
    }

    // ── Loaders preguiçosos (cache por chamada) ──────────────────────
    let tagsCache: { ids: Set<string>; names: Set<string> } | null = null;
    const loadTags = async () => {
      if (tagsCache) return tagsCache;
      const ids = new Set<string>();
      const names = new Set<string>();
      if (contactId) {
        const rows = await prisma.tagOnContact.findMany({
          where: { contactId },
          select: { tagId: true, tag: { select: { name: true } } },
        });
        for (const r of rows) {
          ids.add(r.tagId);
          if (r.tag?.name) names.add(r.tag.name.toLowerCase());
        }
      }
      if (dealId) {
        const rows = await prisma.tagOnDeal.findMany({
          where: { dealId },
          select: { tagId: true, tag: { select: { name: true } } },
        });
        for (const r of rows) {
          ids.add(r.tagId);
          if (r.tag?.name) names.add(r.tag.name.toLowerCase());
        }
      }
      tagsCache = { ids, names };
      return tagsCache;
    };

    let contactRecord: Record<string, unknown> | null | undefined;
    const loadContact = async () => {
      if (contactRecord !== undefined) return contactRecord;
      contactRecord = contactId
        ? ((await prisma.contact.findUnique({ where: { id: contactId } })) as unknown as Record<
            string,
            unknown
          > | null)
        : null;
      return contactRecord;
    };

    let dealRecord: Record<string, unknown> | null | undefined;
    const loadDeal = async () => {
      if (dealRecord !== undefined) return dealRecord;
      dealRecord = dealId
        ? ((await prisma.deal.findUnique({ where: { id: dealId } })) as unknown as Record<
            string,
            unknown
          > | null)
        : null;
      return dealRecord;
    };

    const contactCustomCache = new Map<string, string | null>();
    const loadContactCustom = async (fieldId: string): Promise<string | null> => {
      if (!contactId) return null;
      if (contactCustomCache.has(fieldId)) return contactCustomCache.get(fieldId) ?? null;
      const row = await prisma.contactCustomFieldValue.findUnique({
        where: { contactId_customFieldId: { contactId, customFieldId: fieldId } },
        select: { value: true },
      });
      const val = row?.value ?? null;
      contactCustomCache.set(fieldId, val);
      return val;
    };
    const dealCustomCache = new Map<string, string | null>();
    const loadDealCustom = async (fieldId: string): Promise<string | null> => {
      if (!dealId) return null;
      if (dealCustomCache.has(fieldId)) return dealCustomCache.get(fieldId) ?? null;
      const row = await prisma.dealCustomFieldValue.findUnique({
        where: { dealId_customFieldId: { dealId, customFieldId: fieldId } },
        select: { value: true },
      });
      const val = row?.value ?? null;
      dealCustomCache.set(fieldId, val);
      return val;
    };

    let channelIdsCache: Set<string> | null = null;
    const loadChannelIds = async () => {
      if (channelIdsCache) return channelIdsCache;
      const set = new Set<string>();
      if (contactId) {
        const rows = await prisma.conversation.findMany({
          where: { contactId },
          select: { channelId: true },
        });
        for (const r of rows) if (r.channelId) set.add(r.channelId);
      }
      channelIdsCache = set;
      return channelIdsCache;
    };

    // ── Avaliação (AND) ──────────────────────────────────────────────
    for (const raw of rawConditions) {
      const c = asRecord(raw);
      if (!c) return false;
      const type = readString(c, "type");

      if (type === "tag") {
        const wanted = (readString(c, "tagName") ?? readString(c, "tagId") ?? "").trim();
        if (!wanted) continue; // condição vazia é ignorada (não filtra)
        const { ids, names } = await loadTags();
        if (!ids.has(wanted) && !names.has(wanted.toLowerCase())) return false;
        continue;
      }

      if (type === "field") {
        const fieldId = (readString(c, "fieldId") ?? "").trim();
        const value = readString(c, "value") ?? "";
        if (!fieldId) continue;
        const entity = readString(c, "entity") === "deal" ? "deal" : "contact";

        let actual: unknown = undefined;
        if (entity === "contact") {
          if (NATIVE_CONTACT_FIELDS.has(fieldId)) {
            const rec = await loadContact();
            actual = rec ? rec[fieldId] : undefined;
          } else {
            actual = await loadContactCustom(fieldId);
          }
        } else {
          if (NATIVE_DEAL_FIELDS.has(fieldId)) {
            const rec = await loadDeal();
            actual = rec ? rec[fieldId] : undefined;
          } else {
            actual = await loadDealCustom(fieldId);
          }
        }
        if (!looseEquals(actual, value)) return false;
        continue;
      }

      if (type === "channel") {
        const channelId = (readString(c, "channelId") ?? "").trim();
        if (!channelId) continue;
        // Só compara Channel.id — `data.channel` é o TIPO ("WhatsApp"),
        // não o id da conexão.
        const dataChannelId = readString(data, "channelId");
        if (dataChannelId) {
          if (dataChannelId !== channelId) return false;
          continue;
        }
        const ids = await loadChannelIds();
        if (!ids.has(channelId)) return false;
        continue;
      }

      // Tipo desconhecido: ignora (não filtra) pra ser tolerante a versões.
    }

    return true;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      "[evaluateTriggerConditions] erro ao avaliar condições",
    );
    // Fail-closed: erro ao avaliar → não dispara (não queremos rodar
    // automação ignorando um filtro que o operador definiu).
    return false;
  }
}

async function resolveMessageChannelId(
  contactId: string | undefined,
  data: Record<string, unknown>,
): Promise<string | undefined> {
  const existing = readString(data, "channelId");
  if (existing) return existing;

  const conversationId = readString(data, "conversationId");
  if (conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true },
    });
    if (conv?.channelId) return conv.channelId;
  }

  const phoneNumberId = readString(data, "phoneNumberId");
  if (phoneNumberId) {
    const channel = await prisma.channel.findFirst({
      where: {
        type: "WHATSAPP",
        config: { path: ["phoneNumberId"], equals: phoneNumberId },
      },
      select: { id: true },
    });
    if (channel?.id) return channel.id;
  }

  return undefined;
}

const messageDealSelect = {
  id: true,
  status: true,
  stageId: true,
  stage: { select: { pipelineId: true } },
} as const;

async function enrichContext(
  event: string,
  context: AutomationJobContext,
  triggerConfig?: unknown,
): Promise<AutomationJobContext> {
  const data = asRecord(context.data) ?? {};

  if (event === "lead_score_reached" && context.contactId) {
    if (readNumber(data, "score") === undefined && readNumber(data, "leadScore") === undefined) {
      const contact = await prisma.contact.findUnique({
        where: { id: context.contactId },
        select: { leadScore: true },
      });
      if (contact) {
        return { ...context, data: { ...data, score: contact.leadScore } };
      }
    }
    return context;
  }

  if ((event === "message_received" || event === "message_sent") && context.contactId) {
    const channelId = await resolveMessageChannelId(context.contactId, data);
    const withChannel = channelId ? { ...data, channelId } : data;

    const triggerCfg = asRecord(triggerConfig) ?? {};
    const stageIds = triggerStageIds(triggerCfg);
    const pipelineFilter = readString(triggerCfg, "pipelineId");
    const statusFilter = (readString(triggerCfg, "dealStatus") ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is "OPEN" | "WON" | "LOST" =>
        s === "OPEN" || s === "WON" || s === "LOST",
      );
    const filterActive =
      stageIds.length > 0 || Boolean(pipelineFilter) || statusFilter.length > 0;

    const matched = filterActive
      ? await prisma.deal.findMany({
          where: {
            contactId: context.contactId,
            ...(stageIds.length > 0 ? { stageId: { in: stageIds } } : {}),
            ...(statusFilter.length > 0 ? { status: { in: statusFilter } } : {}),
            ...(pipelineFilter ? { stage: { pipelineId: pipelineFilter } } : {}),
          },
          select: messageDealSelect,
          orderBy: { createdAt: "asc" },
          take: 20,
        })
      : [];
    const openDeals = filterActive
      ? []
      : await prisma.deal.findMany({
          where: { contactId: context.contactId, status: "OPEN" },
          select: messageDealSelect,
          orderBy: { createdAt: "asc" },
          take: 2,
        });
    const choice = classifyMessageDeals({
      filterActive,
      matchedIds: matched.map((d) => d.id),
      openIds: openDeals.map((d) => d.id),
    });

    if (choice.mode === "filter-miss") {
      return {
        ...context,
        dealId: undefined,
        data: {
          ...withChannel,
          ...(stageIds.length > 0 ? { stageId: "__no_matching_stage__" } : {}),
          ...(pipelineFilter
            ? {
                pipelineId: "__no_matching_pipeline__",
                dealPipelineId: "__no_matching_pipeline__",
              }
            : {}),
          ...(statusFilter.length > 0 ? { dealStatus: "__none__" } : {}),
          stageMatchedDealIds: [],
        },
      };
    }
    if (choice.mode === "ambiguous") {
      return {
        ...context,
        dealId: undefined,
        data: { ...withChannel, stageMatchedDealIds: [] },
      };
    }
    if (choice.mode === "matched" || choice.mode === "single-open") {
      const pool = choice.mode === "matched" ? matched : openDeals;
      const preferred = pool.find((d) => d.id === choice.dealId) ?? pool[0];
      if (preferred) {
        return {
          ...context,
          dealId: preferred.id,
          data: {
            ...withChannel,
            stageId: preferred.stageId,
            pipelineId: preferred.stage.pipelineId,
            dealStageId: preferred.stageId,
            dealPipelineId: preferred.stage.pipelineId,
            dealStatus: preferred.status,
            stageMatchedDealIds:
              choice.mode === "matched" ? choice.matchedIds : [preferred.id],
          },
        };
      }
    }

    // Sem OPEN: o mais recente fechado ainda enriquece pós-venda.
    const closed = await prisma.deal.findFirst({
      where: { contactId: context.contactId, status: { in: ["WON", "LOST"] } },
      select: messageDealSelect,
      orderBy: { updatedAt: "desc" },
    });
    if (closed) {
      return {
        ...context,
        dealId: context.dealId ?? closed.id,
        data: {
          ...withChannel,
          stageId: closed.stageId,
          pipelineId: closed.stage.pipelineId,
          dealStageId: closed.stageId,
          dealPipelineId: closed.stage.pipelineId,
          dealStatus: closed.status,
        },
      };
    }
    return { ...context, data: withChannel };
  }

  // Inbound Meta/Baileys dispara conversation_created sem dealId.
  // O inicio-pipe então falha no move_stage ("dealId ausente").
  if (event === "conversation_created") {
    const openingContent = readString(data, "content") ?? readString(data, "text");
    const withAck =
      openingContent && data.isAckOrGreeting === undefined
        ? { ...data, isAckOrGreeting: isAckOrGreetingText(openingContent) }
        : data;

    if (context.contactId && !context.dealId) {
      const deal = await prisma.deal.findFirst({
        where: { contactId: context.contactId, status: "OPEN" },
        select: {
          id: true,
          status: true,
          stageId: true,
          stage: { select: { pipelineId: true } },
        },
        orderBy: { updatedAt: "desc" },
      });
      if (deal) {
        return {
          ...context,
          dealId: deal.id,
          data: {
            ...withAck,
            stageId: deal.stageId,
            pipelineId: deal.stage.pipelineId,
            dealStageId: deal.stageId,
            dealPipelineId: deal.stage.pipelineId,
            dealStatus: deal.status,
          },
        };
      }
    }
    if (withAck !== data) {
      return { ...context, data: withAck };
    }
  }

  if (event === "contact_created" && context.contactId) {
    // 27/mai/26 — Enriquecimento best-effort para suportar filtro por
    // pipeline/estágio em "contato criado". O auto-deal é criado em
    // paralelo (fire-and-forget) com este trigger; se já tiver entrado
    // até aqui, conseguimos preencher o estágio. Quando não, o
    // `evaluateTrigger` filtra fora — o operador deve usar o gatilho
    // `deal_created` se quiser garantia absoluta.
    const deal = await prisma.deal.findFirst({
      where: { contactId: context.contactId, status: "OPEN" },
      select: {
        id: true,
        stageId: true,
        stage: { select: { pipelineId: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    if (deal) {
      return {
        ...context,
        dealId: context.dealId ?? deal.id,
        data: {
          ...data,
          stageId: deal.stageId,
          pipelineId: deal.stage.pipelineId,
        },
      };
    }
  }

  // 29/jul/26 — Rotas de API disparam deal_created/won/lost sem pipelineId
  // no payload; o evaluateTrigger é fail-closed nesse filtro.
  if (
    (event === "deal_created" || event === "deal_won" || event === "deal_lost") &&
    context.dealId &&
    readString(data, "pipelineId") === undefined
  ) {
    const deal = await prisma.deal.findUnique({
      where: { id: context.dealId },
      select: {
        stageId: true,
        contactId: true,
        stage: { select: { pipelineId: true } },
      },
    });
    if (deal) {
      return {
        ...context,
        contactId: context.contactId ?? deal.contactId ?? undefined,
        data: {
          ...data,
          pipelineId: deal.stage.pipelineId,
          stageId: readString(data, "stageId") ?? deal.stageId,
          toStageId: readString(data, "toStageId") ?? deal.stageId,
        },
      };
    }
  }

  return context;
}

/**
 * Lista automações ativas por gatilho com cache curto por org+evento.
 * Em blast de campanha, `conversation_created` dispara 1× por ticket criado
 * (~2k) — sem cache cada chamada relia a tabela automation no PG
 * compartilhado. 10s de staleness: ativação/edição de automação pode
 * demorar até 10s pra refletir em gatilhos — aceitável.
 */
const TRIGGER_LIST_CACHE_TTL_MS = 10_000;
/** Existência de automação ativa por org+evento. 45s de staleness (faixa 30–60s). */
const TRIGGER_EXISTS_CACHE_TTL_MS = 45_000;
const globalForTriggers = globalThis as unknown as {
  triggerAutomationCache?: Map<
    string,
    {
      rows: {
        id: string;
        name: string;
        triggerType: string;
        triggerConfig: unknown;
      }[];
      at: number;
    }
  >;
  triggerExistsCache?: Map<string, { exists: boolean; at: number }>;
};

function triggerCacheKey(event: string): string {
  return `${getOrgIdOrNull() ?? "global"}:${event}`;
}

function rememberAutomationExists(key: string, exists: boolean): void {
  const cache = (globalForTriggers.triggerExistsCache ??= new Map());
  cache.set(key, { exists, at: Date.now() });
}

/**
 * Probe barato + cache in-process: a org tem automação ativa neste gatilho?
 * Reusa a lista em cache (10s) quando ainda está quente.
 */
export async function hasActiveAutomations(event: string): Promise<boolean> {
  const key = triggerCacheKey(event);

  const existsCache = (globalForTriggers.triggerExistsCache ??= new Map());
  const existsHit = existsCache.get(key);
  if (existsHit && Date.now() - existsHit.at < TRIGGER_EXISTS_CACHE_TTL_MS) {
    return existsHit.exists;
  }

  const listHit = globalForTriggers.triggerAutomationCache?.get(key);
  if (listHit && Date.now() - listHit.at < TRIGGER_LIST_CACHE_TTL_MS) {
    const exists = listHit.rows.length > 0;
    rememberAutomationExists(key, exists);
    return exists;
  }

  const row = await prisma.automation.findFirst({
    where: { active: true, triggerType: event },
    select: { id: true },
  });
  const exists = row != null;
  rememberAutomationExists(key, exists);
  return exists;
}

/** @internal testes */
export function resetTriggerExistenceCachesForTests(): void {
  globalForTriggers.triggerExistsCache?.clear();
  globalForTriggers.triggerAutomationCache?.clear();
}

async function listActiveAutomationsForTrigger(event: string) {
  const key = triggerCacheKey(event);
  const cache = (globalForTriggers.triggerAutomationCache ??= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TRIGGER_LIST_CACHE_TTL_MS) return hit.rows;
  const rows = await prisma.automation.findMany({
    where: { active: true, triggerType: event },
    select: { id: true, name: true, triggerType: true, triggerConfig: true },
  });
  cache.set(key, { rows, at: Date.now() });
  rememberAutomationExists(key, rows.length > 0);
  return rows;
}

export async function fireTrigger(  event: string,
  context: { contactId?: string; dealId?: string; data?: unknown; depth?: number }
): Promise<void> {
  // Fast-path: org sem webhook e sem automação neste evento — não paga
  // findMany de hooks, fetch HTTP, lista de automações nem enrich.
  const [hasWebhooks, hasAutomations] = await Promise.all([
    hasIntegrationWebhooks(event),
    hasActiveAutomations(event),
  ]);
  if (!hasWebhooks && !hasAutomations) return;

  // n8n / integrações: dispara mesmo se não houver automação interna
  // e mesmo quando o inbound está em atendimento humano.
  if (hasWebhooks) {
    void dispatchIntegrationWebhooks(event, {
      contactId: context.contactId,
      dealId: context.dealId,
      data: context.data,
    }).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[fireTrigger] integration webhook dispatch failed",
      );
    });
  }

  if (!hasAutomations) return;

  // Ack/obrigado não dispara fluxo sem filtro de etapa (menu, template).
  // Gatilho "mensagem recebida na etapa X" roda mesmo assim: o card
  // dessa etapa tem que sair, inclusive num "sim".
  let idleInbound = false;
  if (
    (event === "conversation_created" || event === "message_received") &&
    context.data &&
    typeof context.data === "object"
  ) {
    try {
      const { shouldSkipIdleInboundAutomation } = await import(
        "@/services/ai/idle-inbound"
      );
      if (await shouldSkipIdleInboundAutomation(asRecord(context.data))) {
        if (event !== "message_received") {
          log.info(
            { event, contact: context.contactId ?? "-" },
            "[fireTrigger] skip — inbound ocioso (ack/obrigado/confirmação)",
          );
          return;
        }
        idleInbound = true;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[fireTrigger] idle inbound check failed",
      );
    }
  }

  // Responsável no deal/conversa NÃO cancela `message_received`.
  // O card pode estar em "Aguardando" com o consultor já atribuído; a
  // mensagem do cliente é o que move para "Em atendimento". O robô
  // pausado continua com o guarda próprio em `processIncomingMessage`.

  let automations;
  try {
    automations = await listActiveAutomationsForTrigger(event);
  } catch (dbErr) {
    log.error({ err: dbErr }, "[fireTrigger] DB error");
    return;
  }

  if (automations.length === 0) return;

  const baseContext: AutomationJobContext = {
    contactId: context.contactId,
    dealId: context.dealId,
    event,
    data: context.data,
    // Propaga a profundidade de encadeamento pro job enfileirado, pra que
    // um efeito colateral (ex.: passo "mover etapa") herde depth+1.
    depth: context.depth ?? 0,
  };

  for (const automation of automations) {
    try {
      if (
        idleInbound &&
        triggerStageIds(asRecord(automation.triggerConfig) ?? {}).length === 0
      ) {
        continue;
      }
      const enriched = await enrichContext(event, baseContext, automation.triggerConfig);
      const passes = evaluateTrigger(automation.triggerType, automation.triggerConfig, {
        ...enriched,
        event,
      });

      if (passes) {
        // Condições extras (Tag/Campo/Canal) do drawer de pipeline —
        // semântica E, avaliadas contra os dados do contato/negócio.
        const condOk = await evaluateTriggerConditions(automation.triggerConfig, {
          contactId: enriched.contactId,
          dealId: enriched.dealId,
          data: enriched.data,
        });
        if (!condOk) {
          continue;
        }

        // ── Trava de reentrada ────────────────────────────────────────
        // Se já existe execução ATIVA (AutomationContext RUNNING) desta
        // automação para este contato, NÃO inicia outra. Um fluxo parado
        // aguardando resposta/botão é retomado por processIncomingMessage;
        // re-disparar do passo 0 criaria execuções paralelas e mensagens
        // duplicadas (bug "recebi mensagens duplicadas").
        if (enriched.contactId) {
          const activeCtx = await getActiveContext(automation.id, enriched.contactId);

          if (activeCtx) {
            log.info(
              {
                automationName: automation.name,
                event,
                contexto: activeCtx.id,
                contato: enriched.contactId,
              },
              "[fireTrigger] skip — execução já ativa",
            );
            // Registro recuperável no painel/API de logs da automação
            // (status SKIPPED) — serve de evidência de que a reentrada foi
            // bloqueada em vez de duplicar o fluxo.
            try {
              const skipData =
                enriched.data && typeof enriched.data === "object"
                  ? (enriched.data as Record<string, unknown>)
                  : {};
              await prisma.automationLog.create({
                data: withOrgFromCtx({
                  automationId: automation.id,
                  contactId: enriched.contactId,
                  dealId: enriched.dealId ?? null,
                  stepId: null,
                  stepType: null,
                  status: "SKIPPED",
                  message: `Reentrada bloqueada — execução já em andamento (contexto ${activeCtx.id})`,
                  payload: {
                    event,
                    evento: event,
                    activeContextId: activeCtx.id,
                    ...(typeof skipData.content === "string" && skipData.content
                      ? { mensagem: skipData.content.slice(0, 200) }
                      : {}),
                    ...(skipData.channel ? { canal: skipData.channel } : {}),
                    ...(typeof skipData.channelId === "string" && skipData.channelId
                      ? { channelId: skipData.channelId }
                      : {}),
                  },
                }),
              });
            } catch {
              /* best-effort: nunca derruba o disparo por causa do log */
            }
            continue;
          }
        }

        if (
          event === "stage_changed" &&
          enriched.contactId &&
          enriched.dealId
        ) {
          const stageData = asRecord(enriched.data) ?? {};
          const toStageId = readString(stageData, "toStageId") ?? readString(stageData, "stageId");
          if (toStageId) {
            const cluster = await loadIntentionalStageClusterIds(enriched.contactId, toStageId);
            const prior = await prisma.automationContext.findFirst({
              where: { automationId: automation.id, contactId: enriched.contactId },
              select: { id: true },
            });
            if (
              shouldSkipIntentionalStageRetrigger({
                dealId: enriched.dealId,
                clusterIdsOldestFirst: cluster,
                hasPriorContext: Boolean(prior),
              })
            ) {
              log.info(
                { automationName: automation.name, dealId: enriched.dealId },
                "[fireTrigger] skip — duplicata de propósito entra no fluxo já existente",
              );
              continue;
            }
          }
        }

        await enqueueAutomation(automation.id, { ...enriched, event });
        log.info({ automationName: automation.name, event }, "[fireTrigger] automação disparada");
      }
    } catch (err) {
      log.error(
        { automationName: automation.name, err: err instanceof Error ? err.message : err },
        "[fireTrigger] Erro na automação",
      );
    }
  }
}

/**
 * Teto de encadeamento de `stage_changed` disparado por efeito de
 * automação (passo "mover etapa", update_field stageId, tool da IA).
 * Protege contra loop A→B→A: a automação A move pro estágio X, o gatilho
 * de B roda e move de volta, e assim por diante. Acima do teto, paramos de
 * re-disparar (a movimentação em si ainda acontece; só não encadeia mais).
 */
const MAX_STAGE_CHAIN_DEPTH = 5;

/**
 * Ponto ÚNICO para notificar mudança de etapa de um negócio ao motor de
 * automações. Usado por TODOS os caminhos que alteram `deal.stageId` fora
 * do kanban/rota (executor de automação, tool da IA, etc.), pra que o
 * gatilho "mudança de fase" fique confiável independente de como a etapa
 * mudou. Idempotente em relação a no-op (from === to) e resiliente
 * (nunca lança — é fire-and-forget).
 *
 * `depth` é a profundidade de encadeamento do disparo (0 = ação direta do
 * usuário/IA; >0 = efeito de outra automação). Acima de MAX_STAGE_CHAIN_DEPTH
 * o disparo é suprimido pra cortar loops.
 */
export async function notifyDealStageChanged(
  dealId: string,
  fromStageId: string | null | undefined,
  toStageId: string | null | undefined,
  opts?: { contactId?: string | null; depth?: number },
): Promise<void> {
  try {
    if (!dealId || !toStageId) return;
    // Replay com handoff real: nenhuma automação da org roda por causa de
    // um card de teste mudando de etapa.
    if (isReplaySandboxActive()) {
      recordBlockedEffect("automation_trigger", `deal_stage_changed:${dealId}`);
      return;
    }
    // Sem mudança real de etapa: não dispara (reordenar na mesma coluna,
    // patch redundante, etc.).
    if (fromStageId && fromStageId === toStageId) return;

    const depth = opts?.depth ?? 0;
    if (depth > MAX_STAGE_CHAIN_DEPTH) {
      log.warn(
        { depth, deal: dealId },
        "[notifyDealStageChanged] encadeamento acima do teto — disparo suprimido p/ evitar loop",
      );
      return;
    }

    await fireTrigger("stage_changed", {
      dealId,
      contactId: opts?.contactId ?? undefined,
      data: { fromStageId: fromStageId ?? undefined, toStageId },
      depth,
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      "[notifyDealStageChanged] falha ao disparar stage_changed",
    );
  }
}

/**
 * Ponto ÚNICO para notificar adição de tag (contato e/ou negócio) ao motor
 * de automações. Chamar SOMENTE quando a tag é efetivamente nova (não
 * re-aplicada) — o chamador é responsável por esse check. Fire-and-forget,
 * nunca lança.
 */
export async function notifyTagAdded(opts: {
  contactId?: string | null;
  dealId?: string | null;
  tagId: string;
  tagName: string;
  depth?: number;
}): Promise<void> {
  try {
    if (!opts.tagId && !opts.tagName) return;
    let contactId = opts.contactId ?? undefined;
    let dealId = opts.dealId ?? undefined;
    // Se só tem dealId, resolve contactId do deal
    if (!contactId && dealId) {
      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        select: { contactId: true },
      });
      contactId = deal?.contactId ?? undefined;
    }
    if (!contactId && !dealId) return;

    await fireTrigger("tag_added", {
      contactId,
      dealId,
      data: { tagId: opts.tagId, tagName: opts.tagName },
      depth: opts.depth ?? 0,
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      "[notifyTagAdded] falha ao disparar tag_added",
    );
  }
}
