import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { botOutboundReplyMark } from "@/lib/conversation-reply-marking";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import {
  ensureWhatsAppConversationForContact,
  maybeResolveUnansweredOutboundTicket,
} from "@/services/whatsapp-conversation";
import {
  CAMPAIGN_DISPATCH_QUEUE_NAME,
  CAMPAIGN_SEND_QUEUE_NAME,
  META_ATTACH_QUEUE_NAME,
  type CampaignDispatchPayload,
  type CampaignSendPayload,
  type MetaAttachPayload,
  enqueueCampaignSendBulk,
  enqueueCampaignDispatch,
  enqueueAutomationJob,
} from "@/lib/queue";
import { processMetaAttach } from "@/jobs/whatsapp/meta-attach.job";
import { analyzeTemplateComponents } from "@/lib/meta-whatsapp/analyze-template-components";
import { metaClientFromConfig, formatMetaSendError } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { getDecryptedChannelConfig } from "@/lib/channels/config";
import { buildContactWhere, type SegmentFilters } from "@/services/segments";
import { metrics, safeLabel } from "@/lib/metrics";
import {
  extractMetaRetryCode,
  isInside24hWindow,
  shouldRetryCampaignSendError,
  isWindowExpiredError,
} from "@/services/campaign-builder/meta-compliance";
import {
  clampCampaignSendRate,
  getCampaignOrgCredit,
  getCampaignSendConcurrency,
  getCampaignSendGlobalRateMax,
  getCampaignSendRateMax,
  isCampaignPerPhoneSlotEnabled,
  isCampaignSendRoundRobinEnabled,
  isCampaignWindowPrefetchEnabled,
} from "@/lib/campaign-send-rate";
import {
  incrementCampaignCounter,
  maybeCompleteCampaign,
} from "@/lib/campaign-counters";
import {
  buildFlowButtonComponent,
} from "@/lib/meta-whatsapp/enrich-template-flow";
import { randomUUID } from "node:crypto";

const BATCH_SIZE = 500;
// Fatia de contatos que o dispatch processa antes de se re-enfileirar. Ceder o
// slot a cada fatia (em vez de enfileirar a campanha inteira) é o que permite
// outras orgs intercalarem na fila campaign-send — sem isso, as primeiras
// campanhas despachadas monopolizam a frente da fila (head-of-line blocking).
const DISPATCH_SLICE = 2000;
const globalWorker = globalThis as unknown as {
  campaignThrottleRedis?: IORedis;
  campaignRowCache?: Map<string, { row: unknown; at: number }>;
};

/** Cache curto do row da campanha no processo do worker — evita 1
 * findUnique por destinatário (2k envios = 2k reads no PG compartilhado). */
const CAMPAIGN_ROW_CACHE_TTL_MS = 5_000;

type CampaignRow = Awaited<ReturnType<typeof loadCampaignRowUncached>>;

async function loadCampaignRowUncached(campaignId: string) {
  return prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { channel: { select: { id: true, provider: true, config: true } } },
  });
}

async function loadCampaignRow(campaignId: string): Promise<CampaignRow> {
  const cache = (globalWorker.campaignRowCache ??= new Map());
  const hit = cache.get(campaignId);
  if (hit && Date.now() - hit.at < CAMPAIGN_ROW_CACHE_TTL_MS) {
    return hit.row as CampaignRow;
  }
  const row = await loadCampaignRowUncached(campaignId);
  cache.set(campaignId, { row, at: Date.now() });
  return row;
}

// ── Template preparation cache ───────────────────────────
// Antes: por destinatário, 1 read PG (whatsAppTemplateConfig) + 1 chamada
// Meta Graph (GET template / listagem paginada) dentro de
// enrichTemplateComponentsForFlowSend. Em blast de 2k: 2k reads + 2k
// chamadas Graph. A definição do template não muda durante o disparo —
// resolvemos 1× por campanha e só regeneramos o flow_token (UUID) por
// destinatário, preservando a correlação por mensagem.

type PreparedTemplate = {
  templateConfigId: string | null;
  bodyPreview: string | null;
  category: string | null;
  buttonLabels: string[];
  /** Componentes base SEM o botão flow (undefined = sem componentes). */
  baseComponents: unknown[] | undefined;
  /** Índice do botão flow na definição; null = template sem flow. */
  flowIndex: string | null;
};

const PREPARED_TEMPLATE_TTL_MS = 60_000;

type PreparedCacheEntry = { prepared: PreparedTemplate; at: number };

function preparedTemplateCache(): Map<string, PreparedCacheEntry> {
  const g = globalWorker as unknown as {
    preparedTemplateCache?: Map<string, PreparedCacheEntry>;
  };
  return (g.preparedTemplateCache ??= new Map());
}

/** Remove o botão flow (probado com token descartável) e devolve o índice. */
function stripFlowButton(components: unknown[]): {
  base: unknown[];
  flowIndex: string | null;
} {
  const base: unknown[] = [];
  let flowIndex: string | null = null;
  for (const c of components) {
    const o = c && typeof c === "object" ? (c as Record<string, unknown>) : null;
    const type = String(o?.type ?? "").toLowerCase();
    const sub = String(
      o?.sub_type ?? (o as { subType?: string } | null)?.subType ?? "",
    ).toLowerCase();
    if (type === "button" && sub === "flow") {
      flowIndex = typeof o?.index === "string" ? o.index : String(o?.index ?? "0");
      continue;
    }
    base.push(c);
  }
  return { base, flowIndex };
}

async function prepareTemplateForCampaign(
  campaign: {
    id: string;
    templateName: string | null;
    templateLanguage: string | null;
    templateComponents: unknown;
  },
  client: ReturnType<typeof metaClientFromConfig>,
): Promise<PreparedTemplate> {
  const cache = preparedTemplateCache();
  const hit = cache.get(campaign.id);
  if (hit && Date.now() - hit.at < PREPARED_TEMPLATE_TTL_MS) return hit.prepared;

  if (!campaign.templateName) throw new Error("Template não definido na campanha.");
  const components = campaign.templateComponents
    ? (campaign.templateComponents as unknown[])
    : undefined;

  let templateGraphId: string | null = null;
  let templateConfigId: string | null = null;
  let bodyPreview: string | null = null;
  let category: string | null = null;
  let buttonLabels: string[] = [];
  try {
    const row = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: campaign.templateName },
      select: { id: true, metaTemplateId: true, bodyPreview: true, category: true },
    });
    templateGraphId = row?.metaTemplateId?.trim() || null;
    templateConfigId = row?.id ?? null;
    bodyPreview = row?.bodyPreview?.trim() || null;
    category = row?.category ?? null;
  } catch {
    /* ignore */
  }

  if ((!bodyPreview || buttonLabels.length === 0) && templateGraphId) {
    try {
      const raw = await client.getMessageTemplateByGraphId(templateGraphId);
      const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const comps = Array.isArray(o?.components) ? (o.components as unknown[]) : [];
      const analysis = analyzeTemplateComponents(comps, {
        parameterFormat: typeof o?.parameter_format === "string" ? o.parameter_format : null,
      });
      if (!bodyPreview) bodyPreview = analysis.bodyText?.trim() || null;
      if (!category && typeof o?.category === "string") category = o.category;
      buttonLabels = analysis.buttons.map((b) => b.text).filter(Boolean);
    } catch {
      /* ignore */
    }
  }

  const probe = await enrichTemplateComponentsForFlowSend(client, {
    templateName: campaign.templateName,
    languageCode: campaign.templateLanguage ?? "pt_BR",
    components,
    templateGraphId,
    // Token sonda — descartado; por destinatário geramos UUID novo.
    flowToken: randomUUID(),
  });

  let prepared: PreparedTemplate;
  if (probe.flowToken && probe.components) {
    const { base, flowIndex } = stripFlowButton(probe.components);
    prepared = {
      templateConfigId,
      bodyPreview,
      category,
      buttonLabels,
      baseComponents: base.length ? base : undefined,
      flowIndex,
    };
  } else {
    prepared = {
      templateConfigId,
      bodyPreview,
      category,
      buttonLabels,
      baseComponents: probe.components,
      flowIndex: null,
    };
  }
  cache.set(campaign.id, { prepared, at: Date.now() });
  return prepared;
}

/** Monta os componentes finais do envio, com flow_token fresco por destinatário. */
function buildSendComponents(prepared: PreparedTemplate): {
  components: unknown[] | undefined;
  flowToken: string | null;
} {
  if (prepared.flowIndex == null) {
    return { components: prepared.baseComponents, flowToken: null };
  }
  const token = randomUUID();
  const btn = buildFlowButtonComponent(prepared.flowIndex, token, null);
  return {
    components: [...(prepared.baseComponents ?? []), btn],
    flowToken: token,
  };
}

function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for campaign worker");
  return url;
}

function getThrottleRedis(): IORedis {
  if (!globalWorker.campaignThrottleRedis) {
    globalWorker.campaignThrottleRedis = new IORedis(getRedisUrl(), {
      maxRetriesPerRequest: null,
    });
  }
  return globalWorker.campaignThrottleRedis;
}

/** Aloca o próximo slot de um token bucket no Redis (mesmo padrão do
 * throttle por phoneNumberId). Usado também para o rate limit global do
 * rodízio, que substitui o `limiter` do BullMQ. */
async function allocateThrottleSlot(key: string, intervalMs: number) {
  const redis = getThrottleRedis();
  const now = Date.now();
  const slot = await redis.eval(
    `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local interval = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])
      local nextTs = tonumber(redis.call("GET", key) or "0")
      if nextTs < now then nextTs = now end
      redis.call("SET", key, tostring(nextTs + interval), "PX", ttl)
      return nextTs
    `,
    1,
    key,
    String(now),
    String(intervalMs),
    String(Math.max(60_000, intervalMs * 5)),
  );
  const waitMs = Math.max(0, Number(slot) - now);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function waitForMetaThrottle(phoneNumberId: string, sendRate: number) {
  // Defense-in-depth: clamp even if DB still has legacy sendRate=80.
  const rate = clampCampaignSendRate(sendRate);
  const intervalMs = Math.max(1, Math.ceil(1000 / rate));
  await allocateThrottleSlot(`campaign:meta:throttle:${phoneNumberId}`, intervalMs);
}

/**
 * Janela 24h da Meta para envio TEXT. Com o prefetch do claim do rodízio
 * (CAMPAIGN_WINDOW_PREFETCH, default on), o `prefetchedLastInboundAt` é o
 * último inbound lido no claim. Mensagens são append-only — o último inbound
 * só pode ficar MAIS recente entre claim e envio — então se o timestamp do
 * claim, avaliado AGORA, está dentro da janela, a query ao vivo concordaria:
 * retorna sem consultar. Fora/ausente (ou caminho FIFO, sem prefetch): checa
 * ao vivo, cobrindo o inbound que chega entre o claim e o envio.
 */
async function isWithinMetaWindow(
  contactId: string,
  channelId: string,
  prefetchedLastInboundAt?: Date | null,
): Promise<boolean> {
  if (
    isCampaignWindowPrefetchEnabled() &&
    prefetchedLastInboundAt &&
    isInside24hWindow(prefetchedLastInboundAt)
  ) {
    return true;
  }
  const latestInbound = await prisma.message.findFirst({
    where: {
      conversation: { contactId, channelId },
      direction: "in",
    },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return isInside24hWindow(latestInbound?.createdAt ?? null);
}

// ── Dispatch worker ──────────────────────────────────────

async function handleDispatch(payload: CampaignDispatchPayload) {
  const { campaignId, cursor } = payload;
  console.info(`[campaign-dispatch] Processing campaign ${campaignId}${cursor ? ` (fatia após ${cursor})` : " (primeira fatia)"}`);

  const campaign = await prismaBase.campaign.findUnique({
    where: { id: campaignId },
    include: { segment: true },
  });

  if (!campaign) {
    console.error(`[campaign-dispatch] Campaign ${campaignId} not found`);
    return;
  }
  const organizationId = campaign.organizationId;

  if (!["PROCESSING", "SCHEDULED"].includes(campaign.status)) {
    console.warn(`[campaign-dispatch] Campaign ${campaignId} status is ${campaign.status}, skipping`);
    return;
  }

  if (campaign.status !== "PROCESSING") {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "PROCESSING" },
    });
  }

  try {
    const filters: SegmentFilters = campaign.segment
      ? (campaign.segment.filters as unknown as SegmentFilters)
      : (campaign.filters as unknown as SegmentFilters) ?? {};

    const where = buildContactWhere(filters);
    where.phone = { not: null };
    // Keyset pagination: estável sob inserts concurrentes e O(1) por fatia
    // (OFFSET aqui reintroduziria o custo quadrático que matamos no MAX(number)).
    if (cursor) {
      where.id = { gt: cursor };
    }

    const contacts = await prisma.contact.findMany({
      where,
      select: { id: true, phone: true, whatsappBsuid: true },
      orderBy: { id: "asc" },
      take: DISPATCH_SLICE,
    });

    if (contacts.length === 0 && !cursor) {
      console.warn(`[campaign-dispatch] No contacts for campaign ${campaignId}`);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "COMPLETED", totalRecipients: 0, completedAt: new Date() },
      });
      return;
    }

    // No modo rodízio (CAMPAIGN_SEND_ROUND_ROBIN, default ligado) o dispatch
    // NÃO enfileira em campaign-send: o sendWorker reabastece do Postgres por
    // org em rodízio com crédito — a fila Redis deixa de ser o backlog e
    // nenhuma org monopoliza o envio. Desligado (rollback), enfileira como
    // antes e o Worker FIFO consome.
    const roundRobin = isCampaignSendRoundRobinEnabled();
    let enqueued = 0;
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      const created = await prisma.campaignRecipient.createMany({
        data: batch.map((c) => ({
          organizationId,
          campaignId,
          contactId: c.id,
          status: "PENDING" as const,
        })),
        skipDuplicates: true,
      });

      if (roundRobin) {
        // createMany com skipDuplicates devolve só os inseridos — retry de
        // fatia não infla totalRecipients.
        enqueued += created.count;
        continue;
      }

      // 1 findMany + addBulk por lote — evita N× (findUnique + queue.add)
      // que gerava storm de Redis/DB no início do disparo (~2k destinatários).
      const recipients = await prisma.campaignRecipient.findMany({
        where: {
          campaignId,
          contactId: { in: batch.map((c) => c.id) },
        },
        select: { id: true, contactId: true },
      });
      const contactById = new Map(batch.map((c) => [c.id, c]));
      const payloads = recipients.flatMap((r) => {
        const contact = contactById.get(r.contactId);
        if (!contact?.phone) return [];
        return [
          {
            campaignId,
            recipientId: r.id,
            contactId: r.contactId,
            contactPhone: contact.phone,
            contactBsuid: contact.whatsappBsuid ?? undefined,
          },
        ];
      });
      const jobs = await enqueueCampaignSendBulk(payloads);
      if (!jobs) {
        throw new Error("Fila campaign-send indisponível (Redis) durante dispatch");
      }
      enqueued += payloads.length;
    }

    // Acumula o total fatiado. A campanha permanece em PROCESSING até a ÚLTIMA
    // fatia: maybeCompleteCampaign e o sweepStuck só completam quando status =
    // SENDING, então marcar SENDING antes da hora faria uma campanha ser
    // concluída no meio (sent+failed >= totalRecipients parcial).
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        totalRecipients: { increment: enqueued },
        ...(cursor ? {} : { startedAt: new Date() }),
      },
    });

    const hasMore = contacts.length === DISPATCH_SLICE;
    if (hasMore) {
      // Re-enfileira a próxima fatia. O re-enqueue vai para o FIM da fila
      // campaign-dispatch, cedendo o slot à próxima campanha — é o que
      // intercala as orgs e evita o head-of-line blocking.
      const nextCursor = contacts[contacts.length - 1].id;
      await enqueueCampaignDispatch({ campaignId, cursor: nextCursor });
      console.info(`[campaign-dispatch] Campaign ${campaignId}: fatia de ${enqueued} recipients ${roundRobin ? "criados" : "enfileirada"}, próxima fatia após ${nextCursor}`);
      return;
    }

    // Última fatia: agora sim marca SENDING — a partir daqui o mecanismo de
    // conclusão (maybeCompleteCampaign / sweepStuck) pode agir com segurança.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "SENDING" },
    });

    console.info(
      roundRobin
        ? `[campaign-dispatch] ${enqueued} recipients criados (fatia final) for campaign ${campaignId} — rodízio reabastece do banco`
        : `[campaign-dispatch] Enqueued ${enqueued} send jobs (fatia final) for campaign ${campaignId}`,
    );
  } catch (err) {
    console.error(`[campaign-dispatch] Error dispatching campaign ${campaignId}:`, err);
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "FAILED", completedAt: new Date() },
    });
  }
}

// ── Send worker ──────────────────────────────────────────

/** Erro tipado: a Meta falhou de forma recuperável e o recipient JÁ foi
 * devolvido a PENDING dentro do processRecipient. No caminho BullMQ o throw
 * propaga para o retry com backoff; no rodízio o caller só contabiliza a
 * tentativa em memória (o recipient é reivindicado de novo num ciclo futuro). */
class CampaignSendRetryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignSendRetryable";
  }
}

type SendOutcome =
  | "sent"
  | "failed"
  /** Campanha pausada/cancelada/ausente — no rodízio o caller devolve o
   * recipient a PENDING para a retomada funcionar. */
  | "skipped_inactive"
  /** Já enviado (idempotência) — nada a fazer. */
  | "skipped_duplicate";

type SendAttemptContext = {
  /** Tentativas já feitas (BullMQ: job.attemptsMade; rodízio: mapa em memória). */
  attemptsMade: number;
  maxAttempts: number;
};

async function processRecipient(
  payload: CampaignSendPayload,
  ctx: SendAttemptContext,
): Promise<SendOutcome> {
  const { campaignId, recipientId, contactId, contactPhone, contactBsuid } = payload;
  // Prefetch da janela 24h vindo do claim do rodízio (null = sem inbound no
  // claim ou prefetch desligado — o check TEXT decide se consulta ao vivo).
  const prefetchedLastInboundAt = payload.lastInboundAt
    ? new Date(payload.lastInboundAt)
    : null;

  // Cache curto (5s) — sem isso cada destinatário relê a campanha.
  const campaign = await loadCampaignRow(campaignId);

  if (!campaign) return "skipped_inactive";

  if (campaign.status === "PAUSED" || campaign.status === "CANCELLED") {
    console.info(`[campaign-send] Campaign ${campaignId} is ${campaign.status}, skipping recipient ${recipientId}`);
    return "skipped_inactive";
  }

  // Idempotência: retry/stall do BullMQ não pode chamar a Meta de novo
  // depois que o destinatário já foi aceito (remat1308_pt1, ago/2026:
  // 246 alunos receberam o HSM 2x ~5 min depois). SENDING não entra
  // aqui — crash antes do POST ainda precisa reenviar.
  const recipient = await prisma.campaignRecipient.findUnique({
    where: { id: recipientId },
    select: { status: true, metaMessageId: true },
  });
  if (!recipient) return "skipped_duplicate";
  if (
    recipient.status === "SENT" ||
    recipient.status === "DELIVERED" ||
    recipient.status === "READ" ||
    Boolean(recipient.metaMessageId)
  ) {
    console.info(
      `[campaign-send] Recipient ${recipientId} já enviado (${recipient.status}), skipping`,
    );
    return "skipped_duplicate";
  }

  await prisma.campaignRecipient.update({
    where: { id: recipientId },
    data: { status: "SENDING" },
  });

  try {
    const provider = campaign.channel.provider;
    const config = getDecryptedChannelConfig({
      provider: campaign.channel.provider,
      config: campaign.channel.config,
    });

    if (campaign.type === "AUTOMATION") {
      if (campaign.automationId) {
        await enqueueAutomationJob({
          automationId: campaign.automationId,
          // org já conhecida aqui — poupa o lookup por automationId no
          // admission control de justiça (lib/automation-fairness.ts).
          organizationId: campaign.organizationId,
          context: {
            contactId,
            event: "campaign_trigger",
            // channelId: canal escolhido no wizard da campanha. Sem ele o
            // executor resolvia pela conversa do contato — que pode estar
            // num canal DISCONNECTED (token invalidado pela Meta), falhando
            // o disparo em massa. O executor lê em `rt.activeChannelId`.
            data: { campaignId, recipientId, channelId: campaign.channelId },
          },
        });
      }
      await markRecipientSent(recipientId, campaignId);
      return "sent";
    }

    if (provider === "META_CLOUD_API") {
      await sendViaMetaCloudApi(campaign, config, contactPhone, contactBsuid, recipientId, campaignId, contactId, prefetchedLastInboundAt);
    } else if (provider === "BAILEYS_MD") {
      await sendViaBaileys(campaign, contactPhone, contactId, recipientId, campaignId);
    } else {
      throw new Error(`Provider ${provider} não suportado para campanhas.`);
    }
    metrics.messages.outbound.inc({
      channel_provider: provider,
      status: "accepted",
      organization: safeLabel(campaign.organizationId),
    });
    return "sent";
  } catch (err) {
    const errorMsg = formatMetaSendError(err);
    console.error(`[campaign-send] Error for recipient ${recipientId}:`, errorMsg);
    const metaCode = extractMetaRetryCode(errorMsg);
    const shouldRetry = shouldRetryCampaignSendError(
      errorMsg,
      ctx.attemptsMade,
      ctx.maxAttempts,
    );
    const windowExpired = isWindowExpiredError(errorMsg);

    if (shouldRetry) {
      await prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { status: "PENDING", errorMessage: `Retryable Meta error (${metaCode})` },
      });
      metrics.messages.outbound.inc({
        channel_provider: "META_CLOUD_API",
        status: "retryable_failed",
        organization: safeLabel(campaign.organizationId),
      });
      metrics.errors.inc({
        scope: "campaign.meta.retryable",
        kind: String(metaCode),
      });
      console.warn(
        `[campaign-send][ALERTA] Retryable Meta error code=${metaCode} campaign=${campaignId} recipient=${recipientId}`,
      );
      throw new CampaignSendRetryable(errorMsg);
    }

    // Update condicional (status != FAILED) para evitar double-count caso o
    // webhook Meta `failed` já tenha marcado este destinatário como FAILED.
    const failedUpdate = await prisma.campaignRecipient.updateMany({
      where: { id: recipientId, status: { not: "FAILED" } },
      data: {
        status: "FAILED",
        errorMessage: windowExpired
          ? "Fora da janela de 24h da Meta. Use template aprovado."
          : errorMsg,
      },
    });
    if (failedUpdate.count > 0) {
      incrementCampaignCounter(campaignId, "failedCount");
    }
    metrics.messages.outbound.inc({
      channel_provider: campaign.channel.provider,
      status: "failed",
      organization: safeLabel(campaign.organizationId),
    });
    return "failed";
  }
}

/** Caminho FIFO (rollback, CAMPAIGN_SEND_ROUND_ROBIN=0): o throw de
 * CampaignSendRetryable propaga para o BullMQ re-tentar com backoff
 * conforme job.opts.attempts — comportamento histórico preservado. */
async function handleSend(
  payload: CampaignSendPayload,
  job: Job<CampaignSendPayload>,
) {
  await processRecipient(payload, {
    attemptsMade: job.attemptsMade,
    maxAttempts: Math.max(1, Number(job.opts.attempts ?? 1)),
  });
}

async function sendViaMetaCloudApi(
  campaign: {
    id: string;
    name: string;
    organizationId: string;
    type: string;
    templateName: string | null;
    templateLanguage: string | null;
    templateComponents: unknown;
    textContent: string | null;
    sendRate: number;
    channel: { id: string };
  },
  config: Record<string, unknown>,
  phone: string,
  bsuid: string | undefined,
  recipientId: string,
  campaignId: string,
  contactId: string,
  prefetchedLastInboundAt?: Date | null,
) {
  // Nunca montar cliente Meta manualmente via `config.accessToken`; usar
  // metaClientFromConfig para garantir decrypt/back-compat centralizados.
  const client = metaClientFromConfig(config);

  if (!client.configured) {
    throw new Error("Canal Meta Cloud API não configurado (token ou phone number ID ausente).");
  }
  const phoneNumberId =
    typeof config.phoneNumberId === "string" && config.phoneNumberId.trim().length > 0
      ? config.phoneNumberId.trim()
      : "unknown";
  await waitForMetaThrottle(phoneNumberId, campaign.sendRate);

  let metaMessageId: string | null = null;
  let messageType: "template" | "text" = "text";
  let content = "";
  let templateConfigId: string | null = null;
  let flowToken: string | null = null;

  if (campaign.type === "TEMPLATE") {
    const prepared = await prepareTemplateForCampaign(campaign, client);
    templateConfigId = prepared.templateConfigId;
    const built = buildSendComponents(prepared);
    flowToken = built.flowToken;
    const result = await client.sendTemplate(
      phone,
      campaign.templateName!,
      campaign.templateLanguage ?? "pt_BR",
      built.components,
      bsuid,
    );
    metaMessageId = result.messages?.[0]?.id ?? null;
    messageType = "template";
    content = buildOutboundTemplateMessageContent(
      campaign.templateName!,
      "generic",
      prepared.category,
      prepared.bodyPreview,
      {
        bodyText: prepared.bodyPreview,
        buttons: prepared.buttonLabels,
      },
    );
  } else if (campaign.type === "TEXT") {
    if (!campaign.textContent) throw new Error("Conteúdo de texto não definido na campanha.");
    const withinWindow = await isWithinMetaWindow(
      contactId,
      campaign.channel.id,
      prefetchedLastInboundAt,
    );
    if (!withinWindow) {
      throw new Error("META_WINDOW_EXPIRED_24H");
    }
    const result = await client.sendText(phone, campaign.textContent, bsuid);
    metaMessageId = result.messages?.[0]?.id ?? null;
    messageType = "text";
    content = campaign.textContent;
  }

  await prisma.campaignRecipient.update({
    where: { id: recipientId },
    data: { status: "SENT", sentAt: new Date(), metaMessageId },
  });
  incrementCampaignCounter(campaignId, "sentCount");

  // Grava no chat (Message) — sem isso a campanha some do histórico do inbox.
  try {
    await persistCampaignOutboundMessage({
      contactId,
      channelId: campaign.channel.id,
      campaignName: campaign.name,
      content,
      messageType,
      externalId: metaMessageId,
      templateConfigId,
      flowToken,
    });
  } catch (err) {
    console.error(
      `[campaign-send] Falha ao gravar Message no chat (envio Meta ok) recipient=${recipientId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Garante conversa OPEN e grava a mensagem outbound da campanha no histórico.
 * Idempotente por `externalId` (wamid Meta).
 */
async function persistCampaignOutboundMessage(input: {
  contactId: string;
  channelId: string;
  campaignName: string;
  content: string;
  messageType: "template" | "text";
  externalId: string | null;
  templateConfigId?: string | null;
  flowToken?: string | null;
  createdAt?: Date;
  sendStatus?: string;
}) {
  if (input.externalId) {
    const existing = await prisma.message.findFirst({
      where: { externalId: input.externalId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const ensured = await ensureWhatsAppConversationForContact(input.contactId, {
    // Campanha TEMPLATE/TEXT: ticket novo só pra histórico do disparo — sem
    // herdar dono (Entrada). Auto-resolve abaixo fecha o ticket em seguida.
    inheritAssignee: false,
    // Mesma razão do "NÃO publicar SSE" no fim desta função: o
    // CONVERSATION_CREATED espelhava uma bolha "Conversa #N aberta" (4 queries
    // + 1 Message) e um publish Redis por destinatário.
    skipActivityLog: true,
  });
  if (
    ensured.status === "skipped_contact_missing" ||
    ensured.status === "skipped_no_channel" ||
    ensured.status === "skipped_no_phone"
  ) {
    console.warn(
      `[campaign-send] Sem conversa para contact=${input.contactId} status=${ensured.status}`,
    );
    return null;
  }

  const conversationId = ensured.conversationId;
  // Canal da CAMPANHA (de onde o Meta realmente enviou). A conversa reusada
  // pode estar num canal antigo/disconnected (ex.: CSV Atendimento); pintar a
  // bolha com esse channelId faz o inbox mostrar "via … 4535" mesmo quando o
  // disparo saiu pelo Acadêmico.
  const channelId = input.channelId || ensured.channelId;

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId,
      content: input.content || `[Campanha: ${input.campaignName}]`,
      direction: "out",
      messageType: input.messageType,
      authorType: "bot" as const,
      senderName: `Campanha: ${input.campaignName}`,
      sendStatus: input.sendStatus ?? "sent",
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.templateConfigId ? { templateConfigId: input.templateConfigId } : {}),
      ...(input.flowToken ? { flowToken: input.flowToken } : {}),
      ...(channelId ? { channelId } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    }),
  });

  // Modelo de ticket para campanhas: após gravar o disparo, fecha o ticket
  // se o aluno ainda não respondeu (`lastInboundAt` null). Cobre tanto
  // `ensured=created` quanto reuso de OPEN órfão (`already_ok` /
  // `backfilled_channel`) — regressão 2026-08-11: campanha "teste 1108"
  // reaproveitou ticket vazio e ficou em Entrada porque só `created`
  // auto-resolvia.
  //
  // Se o contato já tinha atendimento com inbound, NÃO fecha — a mensagem
  // entra no chat aberto normalmente.
  await prisma.conversation
    .update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        ...(await botOutboundReplyMark()),
      },
    })
    .catch(() => {});
  await maybeResolveUnansweredOutboundTicket(conversationId).catch(() => {});

  // NÃO publicar SSE `new_message` em blast de campanha.
  // Cada publish → Redis pub/sub → todos os clientes da org → invalidate
  // inbox/board (scheduleBoardInvalidation). Em ~2k envios isso vira
  // stampede de GET /api/conversations e satura a API/Postgres compartilhado.
  // A mensagem permanece no histórico; o operador vê ao abrir o ticket.

  return saved.id;
}

async function sendViaBaileys(
  campaign: { textContent: string | null; channel: { id: string } },
  phone: string,
  contactId: string,
  recipientId: string,
  campaignId: string,
) {
  // Baileys não é usado neste ambiente: as filas baileys-outbound/control não
  // têm consumidor em produção (entrypoint roteia worker-whatsapp para o
  // campaign-worker). Enfileirar aqui e marcar SENT reportaria 100% enviado
  // sem enviar nada. Falhar explicitamente torna o canal mal configurado
  // visível em vez de produzir sucesso fantasma.
  throw new Error(
    "Provider BAILEYS_MD não suportado neste ambiente (sem consumidor nas filas baileys-outbound/control).",
  );
}

async function markRecipientSent(recipientId: string, campaignId: string) {
  await prisma.campaignRecipient.update({
    where: { id: recipientId },
    data: { status: "SENT", sentAt: new Date() },
  });
  incrementCampaignCounter(campaignId, "sentCount");
}

// Não há check de conclusão por mensagem. O antigo `checkCampaignCompletion`
// forçava `flushCampaignCounters` a cada envio, anulando o buffer de
// campaign-counters (threshold 50 / janela 2s) e gerando 1 `campaign.update` +
// 1 `campaign.findUnique` na MESMA row por mensagem — custo e serialização de
// todos os workers no lock dessa linha.
//
// A conclusão continua garantida por dois caminhos, ambos já existentes:
//   1. `flush()` em campaign-counters chama `maybeCompleteCampaign` sempre que
//      descarrega sent/failed — inclusive no flush por timer, que é o último
//      evento da campanha;
//   2. `sweepStuck` (a cada 30s, abaixo) finaliza qualquer campanha SENDING
//      cujos contadores persistidos já cobrem `totalRecipients`.
// Diferente da amostragem 1/N removida antes, aqui nenhum incremento fica sem
// flush: todo `incrementCampaignCounter` agenda o seu.

// ── Bootstrap ────────────────────────────────────────────

function envPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

/** orgId por campanha — sem TTL longo porque campanha não troca de org. */
async function resolveCampaignOrgId(campaignId: string): Promise<string | null> {
  const g = globalWorker as unknown as {
    campaignOrgCache?: Map<string, string | null>;
  };
  const cache = (g.campaignOrgCache ??= new Map());
  if (cache.has(campaignId)) return cache.get(campaignId) ?? null;
  const camp = await prismaBase.campaign.findUnique({
    where: { id: campaignId },
    select: { organizationId: true },
  });
  const orgId = camp?.organizationId ?? null;
  // Não cachear miss — campanha pode ter sido criada depois do enqueue.
  if (orgId) cache.set(campaignId, orgId);
  return orgId;
}

// ── Rodízio com reabastecimento do Postgres ─────────────
//
// Substitui o consumo FIFO da fila `campaign-send`: em vez de depender da
// ordem em que os jobs foram enfileirados (quem enfileira primeiro monopoliza
// o envio — medido no stress de 23/08: 200 primeiros em wait todos de uma
// org, 4 orgs com sentCount=0 atrás de 153 mil jobs), um loop contínuo
// reivindica lotes de recipients PENDING direto no banco, por org, em
// rodízio com crédito (CAMPAIGN_ORG_CREDIT). O Redis deixa de ser depósito
// de backlog; o banco é a fila.
//
// Justiça: cada ciclo percorre as orgs com pendência em ordem rotativa e
// reivindica uma fatia igual (teto = crédito) de cada — todas avançam
// juntas, independente de quem despachou primeiro.
//
// Segurança:
// - Claim atômico: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE OF r SKIP
//   LOCKED) — dois workers/réplicas nunca pegam o mesmo recipient.
// - Crash após o claim deixa o recipient em SENDING; o sweepStuck devolve
//   SENDING antigos (COALESCE(updatedAt, createdAt)) a PENDING.
// - Idempotência inalterada: processRecipient pula quem já tem metaMessageId
//   ou status SENT/DELIVERED/READ.
// - Rate limit global (WHATSAPP_RATE_LIMIT_MAX/DURATION, via token bucket
//   no Redis) e throttle por phoneNumberId (waitForMetaThrottle) continuam
//   ativos — o rodízio só muda DE ONDE vêm os recipients, não COMO enviam.

type ClaimedRecipient = {
  recipientId: string;
  campaignId: string;
  contactId: string;
  contactPhone: string | null;
  contactBsuid: string | null;
  /** Último inbound do contato no canal da campanha, lido no claim (só
   * campanhas TEXT; null nas demais). Alimenta o check da janela 24h sem
   * query por destinatário. */
  lastInboundAt: Date | null;
  /** phoneNumberId do canal da campanha (channels.config->>'phoneNumberId'
   * — plaintext, não é campo sensível). Dirige o slot de envio por número
   * (2.4). Null em canal sem config (ex.: Baileys) → cai no teto global. */
  phoneNumberId: string | null;
  organizationId: string;
};

function startRoundRobinSender(opts: {
  sendConcurrency: number;
  rateLimitMax: number;
  rateLimitDuration: number;
}) {
  const { sendConcurrency, rateLimitMax, rateLimitDuration } = opts;
  const orgCredit = getCampaignOrgCredit();
  // 2.4: slot por phoneNumberId (default on). A válvula global alta protege
  // o Postgres; o teto real da Meta passa a ser por número. Kill switch:
  // CAMPAIGN_SEND_PER_PHONE_SLOT=0 volta ao teto global único.
  const perPhoneSlot = isCampaignPerPhoneSlotEnabled();
  const globalRateMax = getCampaignSendGlobalRateMax();
  const maxAttempts = Math.max(1, envPositiveInt("WHATSAPP_MAX_ATTEMPTS", 6));
  // Buffer local de recipients reivindicados à espera de um runner: mantém
  // os runners ocupados sem um claim por envio, mas limitado para um crash
  // não deixar muitos SENDING órfãos (o sweeper os recupera em ~5min).
  const localBufferMax = Math.max(sendConcurrency * 8, orgCredit);
  const localQueue: ClaimedRecipient[] = [];
  // Substitui o attemptsMade do BullMQ: tentativas por recipient em memória.
  // Perda em crash é tolerável — o recipient volta a PENDING com budget novo
  // (mesma exposição de um retry BullMQ após flush do Redis).
  const attemptsByRecipient = new Map<string, number>();
  let rotation = 0;
  let orgCache: { orgs: string[]; at: number } = { orgs: [], at: 0 };
  const stats = { claimed: 0, sent: 0, failed: 0, retried: 0 };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Orgs com recipients PENDING — loose index scan (CTE recursiva) sobre
   * (organizationId, status, id): O(#orgs) por consulta, não O(#pendentes).
   * Cache de 1s para não repetir a query a cada rodada do refill. */
  async function listOrgsWithPending(): Promise<string[]> {
    if (orgCache.orgs.length && Date.now() - orgCache.at < 1_000) {
      return orgCache.orgs;
    }
    const rows = await prismaBase.$queryRaw<{ organizationId: string }[]>`
      WITH RECURSIVE orgs AS (
        (SELECT "organizationId"
           FROM campaign_recipients
          WHERE status = 'PENDING'
          ORDER BY "organizationId"
          LIMIT 1)
        UNION ALL
        SELECT (
          SELECT r."organizationId"
            FROM campaign_recipients r
           WHERE r.status = 'PENDING'
             AND r."organizationId" > o."organizationId"
           ORDER BY r."organizationId"
           LIMIT 1
        )
        FROM orgs o
        WHERE o."organizationId" IS NOT NULL
      )
      SELECT "organizationId" FROM orgs WHERE "organizationId" IS NOT NULL`;
    const orgs = rows.map((r) => r.organizationId);
    orgCache = { orgs, at: Date.now() };
    return orgs;
  }

  /** Claim atômico de até `limit` recipients PENDING da org (keyset por id,
   * sem OFFSET). FOR UPDATE OF r SKIP LOCKED: duas réplicas nunca pegam o
   * mesmo recipient. O join em campaigns filtra campanhas pausadas/
   * canceladas — recipient de campanha inativa nem é reivindicado.
   *
   * A coluna `lastInboundAt` elimina o N+1 do check de janela 24h (antes:
   * 1 findFirst em messages por destinatário TEXT no envio). O CASE
   * restringe o subquery a campanhas TEXT — TEMPLATE/AUTOMATION não usam
   * janela e recebem NULL sem custo. A semântica replica exatamente a do
   * findFirst (messages ⋈ conversations por contactId+channelId, direction
   * 'in', createdAt DESC LIMIT 1) — a coluna denormalizada
   * conversations.lastInboundAt NÃO serve (fica stale — ver
   * channel-session.ts). CAMPAIGN_WINDOW_PREFETCH=0 remove o subquery. */
  async function claimBatch(
    organizationId: string,
    limit: number,
  ): Promise<Omit<ClaimedRecipient, "organizationId">[]> {
    const lastInboundSelect = isCampaignWindowPrefetchEnabled()
      ? Prisma.raw(`,
             (CASE WHEN u."campaignType" = 'TEXT' THEN (
               SELECT m."createdAt"
                 FROM messages m
                 JOIN conversations cv ON cv.id = m."conversationId"
                WHERE cv."contactId" = u."contactId"
                  AND cv."channelId" = u."channelId"
                  AND m.direction = 'in'
                ORDER BY m."createdAt" DESC
                LIMIT 1
             ) END) AS "lastInboundAt"`)
      : Prisma.raw(`,
             NULL::timestamptz AS "lastInboundAt"`);
    return prismaBase.$queryRaw<Omit<ClaimedRecipient, "organizationId">[]>`
      WITH batch AS (
        SELECT r.id, c."channelId", c.type AS "campaignType",
               ch.config->>'phoneNumberId' AS "phoneNumberId"
          FROM campaign_recipients r
          JOIN campaigns c ON c.id = r."campaignId"
          JOIN channels ch ON ch.id = c."channelId"
         WHERE r."organizationId" = ${organizationId}
           AND r.status = 'PENDING'
           AND c.status IN ('SENDING', 'PROCESSING')
         ORDER BY r.id
         LIMIT ${limit}::int
         FOR UPDATE OF r SKIP LOCKED
      ),
      upd AS (
        UPDATE campaign_recipients cr
           SET status = 'SENDING', "updatedAt" = now()
          FROM batch
         WHERE cr.id = batch.id
        RETURNING cr.id, cr."campaignId", cr."contactId",
                  batch."channelId", batch."campaignType", batch."phoneNumberId"
      )
      SELECT u.id AS "recipientId",
             u."campaignId",
             u."contactId",
             ct.phone AS "contactPhone",
             ct.whatsapp_bsuid AS "contactBsuid",
             u."phoneNumberId"
             ${lastInboundSelect}
        FROM upd u
        LEFT JOIN contacts ct ON ct.id = u."contactId"`;
  }

  async function refill() {
    for (;;) {
      try {
        const room = localBufferMax - localQueue.length;
        if (room <= 0) {
          await sleep(25);
          continue;
        }
        const orgs = await listOrgsWithPending();
        if (orgs.length === 0) {
          await sleep(500);
          continue;
        }
        // Rodízio: cada ciclo começa a varredura numa org diferente.
        const start = rotation++ % orgs.length;
        const ordered = orgs.slice(start).concat(orgs.slice(0, start));
        // Fatia igual por org nesta rodada (teto = crédito) — é o que faz
        // todas avançarem juntas em vez de uma drenar o buffer sozinha.
        const perOrg = Math.max(
          1,
          Math.min(orgCredit, Math.floor(room / ordered.length)),
        );
        let claimed = 0;
        for (const org of ordered) {
          const roomLeft = localBufferMax - localQueue.length;
          if (roomLeft <= 0) break;
          const batch = await claimBatch(org, Math.min(perOrg, roomLeft));
          if (batch.length === 0) continue;
          claimed += batch.length;
          for (const b of batch) localQueue.push({ ...b, organizationId: org });
        }
        stats.claimed += claimed;
        if (claimed === 0) {
          // Lista de orgs estava velha (pendências acabaram) — relê já.
          orgCache.at = 0;
          await sleep(300);
        }
      } catch (err) {
        console.warn(
          "[campaign-rr] refill falhou (retry em 1s):",
          err instanceof Error ? err.message : err,
        );
        await sleep(1_000);
      }
    }
  }

  async function runner() {
    for (;;) {
      const item = localQueue.shift();
      if (!item) {
        await sleep(25);
        continue;
      }
      try {
        if (!item.contactPhone) {
          // Contato perdeu o telefone depois do dispatch — falha explícita
          // para não travar a conclusão (totalRecipients conta os criados).
          await prismaBase.campaignRecipient.update({
            where: { id: item.recipientId },
            data: { status: "FAILED", errorMessage: "Contato sem telefone no envio." },
          });
          incrementCampaignCounter(item.campaignId, "failedCount");
          stats.failed++;
          continue;
        }
        // Rate limit global — mesmo teto do limiter BullMQ do caminho FIFO.
        await allocateThrottleSlot(
          "campaign:send:global-slot",
          Math.max(1, Math.ceil(rateLimitDuration / rateLimitMax)),
        );
        const payload: CampaignSendPayload = {
          campaignId: item.campaignId,
          recipientId: item.recipientId,
          contactId: item.contactId,
          contactPhone: item.contactPhone,
          contactBsuid: item.contactBsuid ?? undefined,
          lastInboundAt: item.lastInboundAt
            ? item.lastInboundAt.toISOString()
            : null,
        };
        const outcome = await withSystemContext(item.organizationId, () =>
          processRecipient(payload, {
            attemptsMade: attemptsByRecipient.get(item.recipientId) ?? 0,
            maxAttempts,
          }),
        );
        attemptsByRecipient.delete(item.recipientId);
        if (outcome === "skipped_inactive") {
          // Campanha pausada/cancelada entre o claim e o envio — devolve a
          // PENDING para a retomada (resume) funcionar. O join do claim
          // impede re-claim enquanto a campanha estiver inativa.
          await prismaBase.campaignRecipient.updateMany({
            where: { id: item.recipientId, status: "SENDING" },
            data: { status: "PENDING" },
          });
          continue;
        }
        if (outcome === "sent") stats.sent++;
        if (outcome === "failed") stats.failed++;
      } catch (err) {
        if (err instanceof CampaignSendRetryable) {
          // O recipient já voltou a PENDING dentro do processRecipient.
          attemptsByRecipient.set(
            item.recipientId,
            (attemptsByRecipient.get(item.recipientId) ?? 0) + 1,
          );
          stats.retried++;
        } else {
          // Erro inesperado (DB, bug): o recipient pode ter ficado SENDING —
          // o sweepStuck devolve a PENDING em até CAMPAIGN_RR_STALE_SENDING_MS.
          console.error(
            `[campaign-rr] erro inesperado recipient=${item.recipientId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  void refill();
  for (let i = 0; i < sendConcurrency; i++) void runner();

  const statsTimer = setInterval(() => {
    console.info(
      `[campaign-rr] claimed=${stats.claimed} sent=${stats.sent} failed=${stats.failed} retried=${stats.retried} buffer=${localQueue.length} attemptsPendentes=${attemptsByRecipient.size}`,
    );
  }, 60_000);
  statsTimer.unref?.();

  console.info(
    `[campaign-rr] rodízio ativo (concurrency=${sendConcurrency}, orgCredit=${orgCredit}, rateLimit=${rateLimitMax}/${rateLimitDuration}ms, buffer=${localBufferMax})`,
  );
}

export function startCampaignWorkers() {
  const redisUrl = getRedisUrl();
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  // Rate limit global do BullMQ (msgs / duration). Teto adicional além do
  // throttle por phoneNumberId (`campaign:meta:throttle:...`). Capado por
  // CAMPAIGN_SEND_RATE_MAX para não saturar PG/API mesmo se o tier Meta
  // permitir mais. Ops pode subir WHATSAPP_RATE_LIMIT_MAX e
  // CAMPAIGN_SEND_RATE_MAX juntos se a infra aguentar.
  const rateLimitMax = Math.min(
    envPositiveInt("WHATSAPP_RATE_LIMIT_MAX", 80),
    getCampaignSendRateMax(),
  );
  const rateLimitDuration = envPositiveInt(
    "WHATSAPP_RATE_LIMIT_DURATION",
    1000,
  );
  const sendConcurrency = getCampaignSendConcurrency();

  /**
   * Workers BullMQ rodam fora de qualquer request handler — sem session
   * NextAuth e sem AsyncLocalStorage. A `prisma` com a extensao de scope
   * exige RequestContext, entao precisamos resolver a org do job (sem
   * scope, via prismaBase) e wrappear a execucao em `withSystemContext`.
   * Sem isso, todas as queries `prisma.*` dentro do handler quebram com
   * "chamado fora de RequestContext" — ou, pior, em ambientes legados,
   * rodam sem filtro de tenant.
   */
  const dispatchWorker = new Worker<CampaignDispatchPayload>(
    CAMPAIGN_DISPATCH_QUEUE_NAME,
    async (job) => {
      const camp = await prismaBase.campaign.findUnique({
        where: { id: job.data.campaignId },
        select: { organizationId: true },
      });
      if (!camp) {
        console.warn(`[campaign-dispatch] Campaign ${job.data.campaignId} não encontrada`);
        return;
      }
      await withSystemContext(camp.organizationId, () => handleDispatch(job.data));
    },
    { connection, concurrency: 2 },
  );

  // Rodízio (default) ou FIFO BullMQ (rollback via CAMPAIGN_SEND_ROUND_ROBIN=0).
  const roundRobin = isCampaignSendRoundRobinEnabled();

  let sendWorker: Worker<CampaignSendPayload> | null = null;
  if (roundRobin) {
    startRoundRobinSender({ sendConcurrency, rateLimitMax, rateLimitDuration });
    // Backlog pré-rodízio na fila Redis não tem consumidor neste modo — o
    // loop envia os mesmos recipients via PENDING no banco (idempotente),
    // então o backlog é só desperdício de memória. Aviso best-effort.
    void (async () => {
      try {
        const q = new Queue(CAMPAIGN_SEND_QUEUE_NAME, {
          connection: connection.duplicate(),
        });
        const counts = await q.getJobCounts("waiting", "delayed");
        const backlog = counts.waiting + counts.delayed;
        if (backlog > 0) {
          console.warn(
            `[campaign-rr] fila campaign-send tem ${backlog} jobs de backlog sem consumidor (rodízio ativo). Os recipients correspondentes serão enviados via banco; considere obliterar a fila.`,
          );
        }
        await q.close();
      } catch {
        /* aviso best-effort */
      }
    })();
  } else {
    sendWorker = new Worker<CampaignSendPayload>(
      CAMPAIGN_SEND_QUEUE_NAME,
      async (job: Job<CampaignSendPayload>) => {
        // orgId da campanha não muda — cache por processo evita 1 read PG por
        // job (2k destinatários = 2k reads só pra resolver tenant).
        const orgId = await resolveCampaignOrgId(job.data.campaignId);
        if (!orgId) {
          console.warn(`[campaign-send] Campaign ${job.data.campaignId} não encontrada`);
          return;
        }
        await withSystemContext(orgId, () => handleSend(job.data, job));
      },
      {
        connection: connection.duplicate(),
        concurrency: sendConcurrency,
        limiter: { max: rateLimitMax, duration: rateLimitDuration },
      },
    );

    sendWorker.on("failed", (job, err) => {
      console.error(`[campaign-send] Job ${job?.id} failed:`, err.message);
    });
  }

  dispatchWorker.on("failed", (job, err) => {
    console.error(`[campaign-dispatch] Job ${job?.id} failed:`, err.message);
  });

  // Recupera campanhas que já bateram 100% mas ficaram em SENDING (check
  // amostrado antigo, crash no meio do flush, buffer de outro processo).
  const sweepStuck = () => {
    void (async () => {
      try {
        const sending = await prismaBase.campaign.findMany({
          where: { status: "SENDING" },
          select: {
            id: true,
            sentCount: true,
            failedCount: true,
            totalRecipients: true,
          },
        });
        for (const c of sending) {
          if (c.sentCount + c.failedCount >= c.totalRecipients) {
            await maybeCompleteCampaign(c.id);
          }
        }

        // Recupera campanhas travadas em PROCESSING: com o dispatch fatiado, um
        // worker morto entre fatias deixa a campanha em PROCESSING sem ninguém
        // re-enfileirar a próxima. Retoma a partir do maior contactId já
        // enfileirado (keyset), sem reprocessar o que já entrou na fila.
        const staleProcessingMs = 60_000;
        const stuck = await prismaBase.campaign.findMany({
          where: {
            status: "PROCESSING",
            updatedAt: { lt: new Date(Date.now() - staleProcessingMs) },
          },
          select: { id: true },
        });
        for (const c of stuck) {
          const last = await prismaBase.campaignRecipient.findFirst({
            where: { campaignId: c.id },
            orderBy: { contactId: "desc" },
            select: { contactId: true },
          });
          await enqueueCampaignDispatch({ campaignId: c.id, cursor: last?.contactId });
          console.warn(
            `[campaign-worker] campanha ${c.id} travada em PROCESSING — re-enfileirando dispatch a partir de ${last?.contactId ?? "início"}`,
          );
        }

        // Rodízio: recipients travados em SENDING (worker morreu entre o
        // claim e o POST) voltam a PENDING. Restrito a campanhas ativas para
        // usar o índice (campaignId, status) em vez de varrer a tabela. No
        // modo FIFO quem recupera é o stall detection do BullMQ.
        if (roundRobin) {
          const staleSendingMs = envPositiveInt(
            "CAMPAIGN_RR_STALE_SENDING_MS",
            5 * 60_000,
          );
          const cutoff = new Date(Date.now() - staleSendingMs);
          const activeCampaigns = await prismaBase.campaign.findMany({
            where: { status: { in: ["SENDING", "PROCESSING"] } },
            select: { id: true },
          });
          if (activeCampaigns.length > 0) {
            const recovered = await prismaBase.campaignRecipient.updateMany({
              where: {
                campaignId: { in: activeCampaigns.map((c) => c.id) },
                status: "SENDING",
                OR: [
                  { updatedAt: { lt: cutoff } },
                  { updatedAt: null, createdAt: { lt: cutoff } },
                ],
              },
              data: {
                status: "PENDING",
                errorMessage: "Recuperado de SENDING travado (sweep do rodízio)",
              },
            });
            if (recovered.count > 0) {
              console.warn(
                `[campaign-worker] ${recovered.count} recipients SENDING travados → PENDING`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          "[campaign-worker] sweep de conclusão falhou:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  };
  sweepStuck();
  const sweepTimer = setInterval(sweepStuck, 30_000);
  sweepTimer.unref?.();

  // Remux + envio de áudio do inbox (WebM/Opus → Ogg/Opus). Concurrency
  // baixa: o remux JS é CPU-bound (1MB+ / 1000+ pacotes). Não compete
  // com o rate limit de campanha — fila e worker separados.
  const attachConcurrency = envPositiveInt("META_ATTACH_CONCURRENCY", 2);
  const attachWorker = new Worker<MetaAttachPayload>(
    META_ATTACH_QUEUE_NAME,
    async (job: Job<MetaAttachPayload>) => {
      await withSystemContext(job.data.organizationId, () =>
        processMetaAttach(job.data),
      );
    },
    { connection: connection.duplicate(), concurrency: attachConcurrency },
  );
  attachWorker.on("failed", (job, err) => {
    console.error(
      `[meta-attach] job ${job?.id} falhou (attempt ${job?.attemptsMade}):`,
      err instanceof Error ? err.message : err,
    );
    if (!job?.data) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    const error =
      err instanceof Error ? err.message : "Falha no remux/envio de áudio";
    void withSystemContext(job.data.organizationId, async () => {
      const updated = await prisma.message
        .updateMany({
          where: { id: job.data.messageId, sendStatus: "pending" },
          data: { sendStatus: "failed", sendError: error },
        })
        .catch(() => null);
      if (updated && updated.count > 0) {
        await prisma.conversation
          .update({
            where: { id: job.data.conversationId },
            data: { hasError: true },
          })
          .catch(() => {});
        const { sseBus } = await import("@/lib/sse-bus");
        try {
          sseBus.publish("message_status", {
            organizationId: job.data.organizationId,
            conversationId: job.data.conversationId,
            messageId: job.data.messageId,
            internalId: job.data.messageId,
            status: "failed",
            error,
          });
        } catch {
          /* best-effort */
        }
      }
    });
  });
  attachWorker.on("completed", (job) => {
    console.info(`[meta-attach] job ${job.id} concluído`);
  });

  console.info(
    roundRobin
      ? `[campaign-worker] Dispatch worker + rodízio de envio started (sendConcurrency=${sendConcurrency}, rateLimit=${rateLimitMax}/${rateLimitDuration}ms, orgCredit=${getCampaignOrgCredit()}, sendRateMax=${getCampaignSendRateMax()})`
      : `[campaign-worker] Dispatch and send workers started (sendConcurrency=${sendConcurrency}, rateLimit=${rateLimitMax}/${rateLimitDuration}ms, sendRateMax=${getCampaignSendRateMax()})`,
  );
  console.info(
    `[campaign-worker] meta-attach worker started (concurrency=${attachConcurrency})`,
  );

  return { dispatchWorker, sendWorker, attachWorker };
}

if (require.main === module) {
  startCampaignWorkers();
}
