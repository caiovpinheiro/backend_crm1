import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { getHumanAttendanceForContact } from "@/services/attendance-guards";
import { getActiveContext } from "@/services/automation-context";

import {
  enqueueAutomation,
  evaluateTrigger,
  type AutomationJobContext,
} from "@/services/automations";
import { dispatchIntegrationWebhooks } from "@/services/integration-webhooks";

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
    console.error(
      "[evaluateTriggerConditions] erro ao avaliar condições:",
      err instanceof Error ? err.message : err,
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

async function enrichContext(event: string, context: AutomationJobContext): Promise<AutomationJobContext> {
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

    // 27/mai/26 (v3) — Suporte ao filtro `dealStatus` (OPEN/WON/LOST).
    // Antes pegavamos só o deal OPEN; agora priorizamos OPEN mas, se
    // o contato não tem nenhum aberto, caímos no deal mais recente
    // (qualquer status). Assim conseguimos enriquecer com `dealStatus`
    // pra clientes que já viraram WON/LOST e voltaram a mandar
    // mensagem (pós-venda, reengajamento, etc.).
    let deal = await prisma.deal.findFirst({
      where: { contactId: context.contactId, status: "OPEN" },
      select: {
        id: true,
        status: true,
        stageId: true,
        stage: { select: { pipelineId: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!deal) {
      deal = await prisma.deal.findFirst({
        where: { contactId: context.contactId, status: { in: ["WON", "LOST"] } },
        select: {
          id: true,
          status: true,
          stageId: true,
          stage: { select: { pipelineId: true } },
        },
        orderBy: { updatedAt: "desc" },
      });
    }
    if (deal) {
      return {
        ...context,
        dealId: context.dealId ?? deal.id,
        data: {
          ...withChannel,
          stageId: deal.stageId,
          pipelineId: deal.stage.pipelineId,
          dealStageId: deal.stageId,
          dealPipelineId: deal.stage.pipelineId,
          dealStatus: deal.status,
        },
      };
    }
    return { ...context, data: withChannel };
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
};

async function listActiveAutomationsForTrigger(event: string) {
  const orgId = getOrgIdOrNull() ?? "global";
  const key = `${orgId}:${event}`;
  const cache = (globalForTriggers.triggerAutomationCache ??= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TRIGGER_LIST_CACHE_TTL_MS) return hit.rows;
  const rows = await prisma.automation.findMany({
    where: { active: true, triggerType: event },
    select: { id: true, name: true, triggerType: true, triggerConfig: true },
  });
  cache.set(key, { rows, at: Date.now() });
  return rows;
}

export async function fireTrigger(  event: string,
  context: { contactId?: string; dealId?: string; data?: unknown; depth?: number }
): Promise<void> {
  // n8n / integrações: dispara mesmo se não houver automação interna
  // e mesmo quando o inbound está em atendimento humano.
  void dispatchIntegrationWebhooks(event, {
    contactId: context.contactId,
    dealId: context.dealId,
    data: context.data,
  }).catch((err) => {
    console.warn(
      "[fireTrigger] integration webhook dispatch failed:",
      err instanceof Error ? err.message : err,
    );
  });

  // Guarda só no INBOUND: não responder por cima de atendimento humano.
  // message_sent é ação do agente e não pode ser suprimido por ela.
  if (event === "message_received" && context.contactId) {
    try {
      const snap = await getHumanAttendanceForContact(context.contactId);
      if (snap?.suppressAutomation) {
        console.info(
          `[fireTrigger] skip ${event} — atendimento ativo (contact=${context.contactId} conv=${snap.conversationId} assignee=${snap.assignedToId ?? "-"} humanReply=${snap.hasHumanReply})`,
        );
        return;
      }
    } catch (err) {
      console.warn(
        "[fireTrigger] human attendance check failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  let automations;
  try {
    automations = await listActiveAutomationsForTrigger(event);
  } catch (dbErr) {
    console.error(`[fireTrigger] DB error:`, dbErr);
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
      const enriched = await enrichContext(event, baseContext);
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
            console.info(
              `[fireTrigger] skip "${automation.name}" (${event}) — execução já ativa (contexto=${activeCtx.id} contato=${enriched.contactId})`,
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

        await enqueueAutomation(automation.id, { ...enriched, event });
        console.info(`[fireTrigger] "${automation.name}" disparada (${event})`);
      }
    } catch (err) {
      console.error(`[fireTrigger] Erro "${automation.name}":`, err instanceof Error ? err.message : err);
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
    // Sem mudança real de etapa: não dispara (reordenar na mesma coluna,
    // patch redundante, etc.).
    if (fromStageId && fromStageId === toStageId) return;

    const depth = opts?.depth ?? 0;
    if (depth > MAX_STAGE_CHAIN_DEPTH) {
      console.warn(
        `[notifyDealStageChanged] encadeamento acima do teto (${depth}) — disparo suprimido p/ evitar loop (deal=${dealId})`,
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
    console.error(
      "[notifyDealStageChanged] falha ao disparar stage_changed:",
      err instanceof Error ? err.message : err,
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
    console.error(
      "[notifyTagAdded] falha ao disparar tag_added:",
      err instanceof Error ? err.message : err,
    );
  }
}
