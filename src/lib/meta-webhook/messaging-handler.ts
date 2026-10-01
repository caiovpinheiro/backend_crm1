/**
 * Handler dos webhooks de mensageria da Meta:
 *   - object === "page"      -> Facebook Messenger
 *   - object === "instagram" -> Instagram Direct
 *
 * Payload Messenger: `entry[].messaging[]`.
 * Payload Instagram Login (messages): `entry[].changes[].value` com
 * `from.id` / `message` string — NAO so `entry[].messaging[]`.
 * Identidade do canal: `entry.id` (= IGSID / pageId).
 *
 * Fluxo (mesmo padrão do WhatsApp em `handler.ts`): a API valida a
 * assinatura, grava o `MetaWebhookEvent` de auditoria e enfileira em
 * `meta-webhook-events`; o `worker-meta-webhook` chama
 * `processMessagingWebhookPayload` (via `processStoredMetaWebhookEvent`).
 * Nada de Graph/Prisma pesado no processo da API.
 */
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { cache } from "@/lib/cache";
import { metaWebhookMessagingKey, wrapChannelLookup } from "@/lib/cache/keys";
import { enqueueMetaWebhookEvent } from "@/lib/queue";
import { withSystemContext } from "@/lib/webhook-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { createMessageDedup } from "@/lib/message-dedup";
import { CRM_META_APP_SECRET } from "@/lib/meta-constants";
import { verifyMetaWebhookSignature } from "@/lib/meta-webhook-signature";
import { decryptSecret, isEncryptedSecret } from "@/lib/crypto/secrets";
import { publishNewMessage } from "@/lib/realtime-events";
import { onInboundMessageForAi } from "@/services/ai/turn-manager";
import {
  activeConversationOnAccountWhere,
  isActiveConversationUniqueViolation,
  withConversationNumberRetry,
} from "@/services/conversations";
import { maybeDistributeNewInboundTicket } from "@/services/distribution";
import { inheritContactAssigneeForNewTicket } from "@/services/ai/attendance-gate";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import { sanitizeContactName } from "@/lib/display-name";
import { notifyInboundMessage } from "@/lib/web-push";
import { touchInbound, warnTouchInboundFailed } from "@/lib/conversation-inbound";
import { getLogger } from "@/lib/logger";
import { fireTrigger, buildMessageTriggerData, emitConversationCreated, openingMessageTriggerExtra } from "@/services/automation-triggers";
import { ensureOpenDealForContact } from "@/services/auto-deals";
import {
  asMetaId,
  configMetaIds,
  extractMessagingEvents,
  type MessagingEvent,
  type WebhookEntry,
} from "@/lib/meta-webhook/messaging-payload";

const log = getLogger("meta-messaging-webhook");
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || "";
const REQUIRE_SIGNATURE = process.env.NODE_ENV === "production";
const IG_APP_SECRET = process.env.INSTAGRAM_APP_SECRET?.trim() || "";

/** Secrets que a Meta usa no X-Hub-Signature-256 deste endpoint. */
function messagingWebhookSecrets(): string[] {
  return [...new Set([CRM_META_APP_SECRET, IG_APP_SECRET].filter(Boolean))];
}

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * `META_WEBHOOK_ASYNC=0` volta ao processamento síncrono na API (rollback) —
 * mesma flag do webhook WhatsApp em `handler.ts`.
 */
const META_WEBHOOK_ASYNC = process.env.META_WEBHOOK_ASYNC !== "0";
/** Cache do mapeamento entry.id → org/canal (invalidado pela versão `channel:<org>`). */
const ENTRY_SCOPE_CACHE_TTL_SEC = 60;
/** Cache do nome público por PSID/IGSID. */
const PROFILE_CACHE_TTL_SEC = 600;
/** Teto do GET de perfil no Graph — o job não pode ficar preso num Graph lento. */
const PROFILE_FETCH_TIMEOUT_MS = 5_000;

type Platform = "messenger" | "instagram";

// ── GET: verificacao ────────────────────────────────────────

/**
 * GET /api/webhooks/meta/messaging — handshake da Meta.
 * Valida hub.verify_token contra META_WEBHOOK_VERIFY_TOKEN global.
 */
export async function handleMessagingWebhookGet(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (!VERIFY_TOKEN) {
    log.error("META_WEBHOOK_VERIFY_TOKEN nao configurado — recusando handshake");
    return NextResponse.json(
      { error: "Webhook verification not configured" },
      { status: 503 },
    );
  }
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log.info("Verificacao messaging webhook: OK");
    return new Response(challenge ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// ── POST: recebimento ──────────────────────────────────────

export async function handleMessagingWebhookPost(
  request: Request,
  opts?: {
    /** Assinatura já validada pelo caller (encaminhamento da URL WhatsApp). */
    skipSignature?: boolean;
    /** Evento de auditoria já gravado pelo caller — não gravar de novo. */
    metaWebhookEventId?: string | null;
  },
): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const secrets = messagingWebhookSecrets();
  let signatureValid = Boolean(opts?.skipSignature);
  if (!opts?.skipSignature) {
    if (secrets.length > 0) {
      signatureValid = secrets.some((s) =>
        verifyMetaWebhookSignature(rawBody, signature, s),
      );
      if (!signatureValid) {
        log.warn(
          `Assinatura invalida (${secrets.length} secret(s)) — recusando POST messaging`,
        );
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    } else if (REQUIRE_SIGNATURE) {
      log.error("PROD sem META_APP_SECRET/INSTAGRAM_APP_SECRET — recusando POST messaging");
      return NextResponse.json(
        { error: "Webhook signature verification not configured" },
        { status: 503 },
      );
    } else {
      log.debug("Sem App Secret — assinatura nao verificada (dev)");
    }
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const object = typeof body.object === "string" ? body.object : "";
  let platform: Platform | null = null;
  if (object === "page") platform = "messenger";
  else if (object === "instagram") platform = "instagram";
  else {
    // Nao e' um objeto messaging — ignoramos (o handler WhatsApp trata outros).
    return NextResponse.json({ status: "ignored", object });
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];

  // Org/canal do POST (lookup cacheado): necessário para o payload do job
  // (`withSystemContext` no worker) e para a linha de auditoria. O worker
  // resolve o canal de cada entry de novo (com token) em `processEntry`.
  const scope = await resolveMessagingScope(entries, platform);
  if (!scope) {
    log.warn(
      { platform, entries: entries.length },
      "POST messaging sem entry.id mapeado a canal Instagram/Messenger — ignorando",
    );
    if (opts?.metaWebhookEventId) {
      await markMessagingEventProcessed(opts.metaWebhookEventId, "unmapped_channel");
    }
    return NextResponse.json({ status: "ignored_unmapped_channel" });
  }

  const metaWebhookEventId =
    opts?.metaWebhookEventId ??
    (await createMessagingWebhookEvent({
      rawBody: body,
      headers: pickWebhookHeaders(request.headers),
      signatureValid,
      objectType: object,
      organizationId: scope.organizationId,
      channelId: scope.channelId,
      entries,
    }));

  if (!META_WEBHOOK_ASYNC) {
    // Rollback explícito (META_WEBHOOK_ASYNC=0): processa síncrono na API.
    await processMessagingWebhookPayload(body, { metaWebhookEventId });
    return NextResponse.json({ status: "ok" });
  }

  if (!metaWebhookEventId) {
    // Sem auditoria não há fonte da verdade para o worker. 503 → a Meta
    // reenvia; não processar síncrono no processo da API.
    log.warn("MetaWebhookEvent (messaging) não persistido — 503 para retry da Meta");
    return NextResponse.json(
      { status: "unavailable", message: "Auditoria do webhook indisponível" },
      { status: 503 },
    );
  }

  const queued = await enqueueMetaWebhookEvent(
    { metaWebhookEventId, organizationId: scope.organizationId },
    { jobId: messagingWebhookJobId(rawBody) },
  ).catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "enqueue messaging falhou");
    return null;
  });
  if (!queued) {
    log.warn(
      "enqueue meta-webhook (messaging) falhou (Redis?) — 503 para retry da Meta (sem sync na API)",
    );
    return NextResponse.json(
      { status: "unavailable", message: "Fila Meta indisponível" },
      { status: 503 },
    );
  }
  return NextResponse.json({ status: "accepted" });
}

/**
 * `jobId` determinístico por corpo: um reenvio da Meta (timeout do lado
 * dela, 5xx nosso) com o mesmo payload colapsa no mesmo job enquanto ele
 * existir na fila. Depois disso a idempotência é da `mid` (unique
 * `(organizationId, externalId)` em `processEvent`).
 */
export function messagingWebhookJobId(rawBody: string): string {
  return `meta-msg-${createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 40)}`;
}

/**
 * Loop de processamento do payload Instagram/Messenger. Roda no
 * `worker-meta-webhook` (via `processStoredMetaWebhookEvent`) ou, com
 * `META_WEBHOOK_ASYNC=0`, síncrono na API. Cada entry resolve o próprio
 * canal e roda em `withSystemContext` da org dele. Erros por entry são
 * não-fatais (mesma semântica do processamento síncrono antigo); ao final
 * o `MetaWebhookEvent` é marcado como processado.
 */
export async function processMessagingWebhookPayload(
  body: Record<string, unknown>,
  opts: { metaWebhookEventId: string | null },
): Promise<void> {
  const object = typeof body.object === "string" ? body.object : "";
  const platform: Platform | null =
    object === "page" ? "messenger" : object === "instagram" ? "instagram" : null;
  if (!platform) {
    if (opts.metaWebhookEventId) {
      await markMessagingEventProcessed(opts.metaWebhookEventId, "object_ignored");
    }
    return;
  }
  const entries = Array.isArray(body.entry) ? (body.entry as WebhookEntry[]) : [];
  for (const entry of entries) {
    try {
      await processEntry(entry, platform);
    } catch (err) {
      log.error("Erro ao processar entry (nao-fatal):", err);
    }
  }
  if (opts.metaWebhookEventId) {
    await markMessagingEventProcessed(opts.metaWebhookEventId, null);
  }
}

// ── Auditoria (MetaWebhookEvent) ───────────────────────────

function pickWebhookHeaders(h: Headers): Record<string, string> {
  const keys = [
    "x-hub-signature-256",
    "x-forwarded-for",
    "x-real-ip",
    "user-agent",
    "content-type",
    "x-request-id",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = h.get(k);
    if (v) out[k] = v;
  }
  return out;
}

function summarizeMessagingEventType(entries: WebhookEntry[]): string {
  for (const entry of entries) {
    const first = extractMessagingEvents(entry)[0];
    if (!first) continue;
    if (first.message?.is_echo) return "echo";
    if (first.message) return "message";
    if (first.postback) return "postback";
    if (first.read) return "read";
    if (first.delivery) return "delivery";
  }
  return "unknown";
}

/** Persiste o POST bruto (mesma tabela do WhatsApp). Falha é não-fatal. */
async function createMessagingWebhookEvent(args: {
  rawBody: Record<string, unknown>;
  headers: Record<string, string>;
  signatureValid: boolean;
  objectType: string;
  organizationId: string;
  channelId: string;
  entries: WebhookEntry[];
}): Promise<string | null> {
  try {
    const created = await prismaBase.metaWebhookEvent.create({
      data: {
        organizationId: args.organizationId,
        channelId: args.channelId,
        signatureValid: args.signatureValid,
        objectType: args.objectType,
        eventType: summarizeMessagingEventType(args.entries),
        rawBody: args.rawBody as Prisma.InputJsonValue,
        headers: args.headers as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    log.error("Falha ao persistir MetaWebhookEvent (messaging, não-fatal):", err);
    return null;
  }
}

async function markMessagingEventProcessed(
  id: string,
  errorMessage: string | null,
): Promise<void> {
  try {
    await prismaBase.metaWebhookEvent.update({
      where: { id },
      data: { processed: true, processingError: errorMessage },
    });
  } catch (err) {
    log.debug("Falha ao marcar MetaWebhookEvent (messaging) como processado:", err);
  }
}

// ── Types minimo do payload ─────────────────────────────────

type WebhookBody = {
  object?: unknown;
  entry?: WebhookEntry[];
};

// ── Resolve org/canal por entry.id ─────────────────────────

type ChannelHit = {
  channelId: string;
  organizationId: string;
  channelType: "FACEBOOK" | "INSTAGRAM";
  provider: "META_CLOUD_API" | "META_INSTAGRAM_LOGIN";
  /** Messenger: pageId. Instagram direct: instagramUserId. */
  senderRef: string;
  accessToken: string;
};

const CHANNEL_SELECT = {
  id: true,
  organizationId: true,
  type: true,
  provider: true,
  config: true,
} as const;

function toChannelHit(channel: {
  id: string;
  organizationId: string;
  type: string;
  provider: string;
  config: Prisma.JsonValue;
}): ChannelHit {
  const cfg = (channel.config ?? {}) as Record<string, unknown>;
  const tokenRaw = typeof cfg.accessToken === "string" ? cfg.accessToken : "";
  const token =
    tokenRaw && isEncryptedSecret(tokenRaw) ? safeDecrypt(tokenRaw) : tokenRaw;
  const senderRef =
    asMetaId(cfg.instagramUserId) ||
    asMetaId(cfg.instagramAccountId) ||
    asMetaId(cfg.pageId);

  return {
    channelId: channel.id,
    organizationId: channel.organizationId,
    channelType: channel.type as "FACEBOOK" | "INSTAGRAM",
    provider: channel.provider as "META_CLOUD_API" | "META_INSTAGRAM_LOGIN",
    senderRef,
    accessToken: token,
  };
}

async function findChannelByEntryId(
  entryId: string,
  platform: Platform,
): Promise<ChannelHit | null> {
  const type = platform === "instagram" ? "INSTAGRAM" : "FACEBOOK";
  const paths =
    platform === "instagram"
      ? (["instagramUserId", "instagramAccountId", "pageId"] as const)
      : (["pageId"] as const);

  for (const path of paths) {
    const channel = await prismaBase.channel.findFirst({
      where: { type, config: { path: [path], equals: entryId } },
      select: CHANNEL_SELECT,
    });
    if (channel) return toChannelHit(channel);
  }

  const fallback = await prismaBase.channel.findMany({
    where: { type },
    select: CHANNEL_SELECT,
  });
  const matched = fallback.filter((row) => configMetaIds(row.config).has(entryId));
  if (matched.length === 1) return toChannelHit(matched[0]);
  if (matched.length > 1) {
    log.warn(
      { entryId, platform, count: matched.length },
      "multiplos canais para o mesmo entry.id",
    );
    return null;
  }
  return null;
}

function safeDecrypt(v: string): string {
  try {
    return decryptSecret(v);
  } catch (err) {
    log.error("Falha ao decriptar accessToken:", err);
    return "";
  }
}

type MessagingScope = { organizationId: string; channelId: string };

/**
 * Org/canal do POST para o job e a auditoria, sem token (cacheável).
 * Percorre as entries até uma resolver (entry.id, depois recipient.id —
 * mesma ordem de `processEntry`). Cache 60 s sob o prefixo `meta_wh:*`,
 * invalidado na edição de canal da org junto com o mapeamento do WhatsApp.
 */
async function resolveMessagingScope(
  entries: WebhookEntry[],
  platform: Platform,
): Promise<MessagingScope | null> {
  const lookup = (id: string) =>
    wrapChannelLookup<MessagingScope>(
      metaWebhookMessagingKey(platform, id),
      ENTRY_SCOPE_CACHE_TTL_SEC,
      async () => {
        const hit = await findChannelByEntryId(id, platform);
        return hit ? { organizationId: hit.organizationId, channelId: hit.channelId } : null;
      },
    );

  for (const entry of entries) {
    const entryId = asMetaId(entry.id);
    if (!entryId) continue;
    const byEntry = await lookup(entryId);
    if (byEntry) return byEntry;
    const recipientId = asMetaId(extractMessagingEvents(entry)[0]?.recipient?.id);
    if (recipientId && recipientId !== entryId) {
      const byRecipient = await lookup(recipientId);
      if (byRecipient) return byRecipient;
    }
  }
  return null;
}

// ── Processa uma entry ─────────────────────────────────────

async function processEntry(entry: WebhookEntry, platform: Platform): Promise<void> {
  const entryId = asMetaId(entry.id);
  const events = extractMessagingEvents(entry);
  if (!entryId) {
    log.warn({ keys: Object.keys(entry) }, "entry messaging sem id — ignorada");
    return;
  }
  if (events.length === 0) {
    log.info(
      { entryId, platform, keys: Object.keys(entry) },
      "entry sem messaging/changes de mensagem — ignorada",
    );
    return;
  }

  let hit = await findChannelByEntryId(entryId, platform);
  if (!hit) {
    const recipientId = asMetaId(events[0]?.recipient?.id);
    if (recipientId && recipientId !== entryId) {
      hit = await findChannelByEntryId(recipientId, platform);
    }
  }
  if (!hit) {
    log.warn(
      { entryId, platform },
      "entry.id nao mapeado a nenhum canal Instagram/Messenger — ignorando",
    );
    return;
  }
  log.info(
    { entryId, platform, channelId: hit.channelId, events: events.length },
    "webhook messaging: processando entry",
  );

  await withSystemContext(hit.organizationId, async () => {
    for (const ev of events) {
      try {
        await processEvent(ev, hit, platform);
      } catch (err) {
        log.error("Erro ao processar evento (nao-fatal):", err);
      }
    }
  });
}

async function processEvent(
  ev: MessagingEvent,
  hit: ChannelHit,
  platform: Platform,
): Promise<void> {
  const senderId = asMetaId(ev.sender?.id);
  if (!senderId) {
    log.warn({ channelId: hit.channelId }, "evento messaging sem sender.id — ignorado");
    return;
  }

  // Ignora echo do proprio negocio (nossa mensagem enviada volta como evento)
  if (ev.message?.is_echo) {
    log.info(
      `echo ignorado mid=${ev.message.mid ?? ""} channel=${hit.channelId}`,
    );
    return;
  }

  // Ignora acks (read/delivery) por enquanto — foco no MVP e' new_message.
  if (ev.read || ev.delivery) return;

  const isPostback = Boolean(ev.postback);
  const isMessage = Boolean(ev.message);
  if (!isPostback && !isMessage) return;

  const externalId =
    (ev.message?.mid || ev.postback?.mid || "").trim() || null;
  const text = isPostback
    ? ev.postback?.title || ev.postback?.payload || ""
    : ev.message?.text || "";
  const timestamp = ev.timestamp ? new Date(ev.timestamp) : new Date();

  // Idempotencia: se ja gravamos essa mid, ignora.
  if (externalId) {
    const existing = await prisma.message.findFirst({
      where: { externalId },
      select: { id: true },
    });
    if (existing) return;
  }

  const contact = await upsertContact(senderId, platform, hit);
  const channelLabel = platform === "instagram" ? "Instagram" : "Meta";
  const sourceName =
    platform === "instagram" ? "Instagram Direct" : "Messenger";

  // Mesma ordem do WhatsApp (handler.ts / baileys): contato novo dispara
  // contact_created ANTES do auto-deal, e o deal é garantido também para
  // contato existente sem histórico (v3 — auto-deals.ts).
  if (contact.isNew) {
    fireTrigger("contact_created", {
      contactId: contact.id,
      data: { source: sourceName, channel: channelLabel },
    }).catch((err) => log.warn("Falha no gatilho contact_created:", err));
  }

  ensureOpenDealForContact({
    contactId: contact.id,
    contactName: contact.name,
    source: platform === "instagram" ? "auto_instagram" : "auto_messenger",
    logTag: "meta-messaging-webhook",
    channelId: hit.channelId,
  }).catch((err) => log.warn("Falha ao garantir deal aberto:", err));

  // Anexos: guardamos o primeiro URL como preview no `content` quando nao ha texto.
  let content = text;
  const firstAttachment = ev.message?.attachments?.[0];
  if (!content && firstAttachment) {
    const url = firstAttachment.payload?.url;
    const type = firstAttachment.type || "attachment";
    content = url ? `[${type}] ${url}` : `[${type}]`;
  }

  const conversation = await findOrCreateConversation(
    contact.id,
    platform,
    hit.channelId,
    {
      content,
      messageType: firstAttachment?.type || (content ? "text" : undefined),
    },
  );

  // O `findFirst` acima resolve a reentrega tardia; a corrida (dois eventos
  // da mesma mid processados em paralelo) é fechada pelo unique
  // (organizationId, externalId). Perdedor = duplicata: sai sem repetir
  // SSE / push / gatilho / resposta da IA, igual ao early-return de cima.
  const msgCreated = await createMessageDedup(() =>
    prisma.message.create({
      data: withOrgFromCtx({
        conversationId: conversation.id,
        channelId: hit.channelId,
        direction: "in" as const,
        content: content || "",
        externalId,
        createdAt: timestamp,
      }),
    }),
  );
  if (!msgCreated) {
    log.info(`duplicata por corrida mid=${externalId ?? ""} — ignorando`);
    return;
  }

  // TODO(inbox-ig): este ingest ainda não incrementa unread nem seta
  // lastMessageDirection — bug de UX separado; não misturar com firstInboundAt.
  await touchInbound({ conversationId: conversation.id, at: timestamp }).catch((err) =>
    warnTouchInboundFailed(err, {
      conversationId: conversation.id,
      channel: conversation.channel ?? platform,
    }),
  );

  try {
    // Org do canal, não do contexto: o guard fail-closed do sse-bus
    // descarta o evento sem org e este ingest roda no worker.
    publishNewMessage({
      organizationId: hit.organizationId,
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "in",
      assignedToId: conversation.assignedToId ?? null,
      content,
      timestamp,
    });
  } catch (err) {
    log.warn("SSE publish falhou (nao-fatal):", err);
  }

  notifyInboundMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    contactName: contact.name,
    preview: content || "[midia]",
    channel: channelLabel,
  }).catch((err) => log.debug("push falhou (nao-fatal):", err));

  try {
    await fireTrigger("message_received", {
      contactId: contact.id,
      data: buildMessageTriggerData({
        channel: platform,
        channelId: hit.channelId,
        conversationId: conversation.id,
        content,
      }),
    });
  } catch (err) {
    log.error("Falha ao disparar gatilho message_received:", err);
  }

  if (content?.trim()) {
    void onInboundMessageForAi({
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: msgCreated.id,
      userMessage: content,
      channel: "messaging",
    });
  }
}

// ── Upsert de Contact por PSID/IGSID ────────────────────────

async function upsertContact(
  externalUserId: string,
  platform: Platform,
  hit: ChannelHit,
): Promise<{ id: string; name: string; isNew: boolean }> {
  const field = platform === "instagram" ? "instagramIgsid" : "messengerPsid";

  const existing = await prisma.contact.findFirst({
    where: { [field]: externalUserId } as Prisma.ContactWhereInput,
    select: { id: true, name: true },
  });
  if (existing) return { ...existing, isNew: false };

  // Best-effort fetch do perfil publico (nome). Falhas nao bloqueiam.
  const profile = await fetchProfileName(externalUserId, hit).catch(() => null);
  const name =
    (profile ? sanitizeContactName(profile) || profile : null) ||
    `${platform === "instagram" ? "Instagram" : "Messenger"} ${externalUserId.slice(-6)}`;
  const sourceName =
    platform === "instagram" ? "Instagram Direct" : "Messenger";

  try {
    const created = await createContactWithNumber({
      name,
      [field]: externalUserId,
      lifecycleStage: "LEAD",
      source: sourceName,
    });
    return { ...created, isNew: true };
  } catch (err) {
    // Corrida: outro webhook criou o contato simultaneamente.
    if (isPrismaUniqueViolation(err)) {
      const won = await prisma.contact.findFirst({
        where: { [field]: externalUserId } as Prisma.ContactWhereInput,
        select: { id: true, name: true },
      });
      if (won) return { ...won, isNew: false };
    }
    throw err;
  }
}

/**
 * Nome público por PSID/IGSID. Cache de 10 min por usuário (retries do
 * job e corridas entre eventos não batem no Graph de novo) e timeout de
 * 5 s — um Graph lento não pode segurar o job (nem, antes, a request).
 * Só o acerto é cacheado: falha/timeout deixa a próxima tentativa tentar.
 */
async function fetchProfileName(
  userId: string,
  hit: ChannelHit,
): Promise<string | null> {
  if (!hit.accessToken) return null;
  const cacheKey = `meta_msg:profile:${hit.provider}:${userId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached) return cached;
  try {
    // Messenger: graph.facebook.com/{psid}?fields=name (Page token)
    // IG Direct: graph.instagram.com/v21.0/{igsid}?fields=name,username
    const base =
      hit.provider === "META_INSTAGRAM_LOGIN"
        ? `https://graph.instagram.com/${GRAPH_API_VERSION}`
        : GRAPH_BASE;
    const fields = hit.provider === "META_INSTAGRAM_LOGIN" ? "name,username" : "name";
    const url = new URL(`${base}/${userId}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", hit.accessToken);
    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string; username?: string };
    const name = data.name?.trim() || data.username?.trim() || null;
    if (name) await cache.set(cacheKey, name, PROFILE_CACHE_TTL_SEC);
    return name;
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    log.debug(
      { userId, provider: hit.provider, timeout: isTimeout },
      "fetch de perfil falhou (não-fatal)",
    );
    return null;
  }
}

async function createContactWithNumber(
  fields: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  return insertContactWithNextNumber(
    fields as Omit<Prisma.ContactUncheckedCreateInput, "number" | "organizationId">,
    { id: true, name: true },
  );
}

// ── findOrCreateConversation ──────────────────────────────

async function findOrCreateConversation(
  contactId: string,
  platform: Platform,
  channelId: string,
  opening?: { content?: string | null; messageType?: string | null },
): Promise<{ id: string; assignedToId: string | null }> {
  const channelSlug = platform;

  const findOnAccount = (accountId: string | null) =>
    prisma.conversation.findFirst({
      where: activeConversationOnAccountWhere({
        contactId,
        channel: channelSlug,
        channelId: accountId,
      }),
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, channelId: true, assignedToId: true },
    });

  const existing = await findOnAccount(channelId);
  if (existing) {
    await maybeDistributeNewInboundTicket({
      conversationId: existing.id,
      contactId,
      assignedToId: existing.assignedToId ?? null,
    });
    return { id: existing.id, assignedToId: existing.assignedToId ?? null };
  }

  const orphan = await findOnAccount(null);
  if (orphan) {
    await prisma.conversation.update({
      where: { id: orphan.id },
      data: { channelId },
    });
    await maybeDistributeNewInboundTicket({
      conversationId: orphan.id,
      contactId,
      assignedToId: orphan.assignedToId ?? null,
    });
    return { id: orphan.id, assignedToId: orphan.assignedToId ?? null };
  }

  const inheritAssignee = await inheritContactAssigneeForNewTicket(contactId);

  try {
    const created = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          contactId,
          channel: channelSlug,
          channelId,
          status: "OPEN" as const,
          ...(inheritAssignee ? { assignedToId: inheritAssignee } : {}),
        }),
        select: { id: true, assignedToId: true },
      }),
    );
    await maybeDistributeNewInboundTicket({
      conversationId: created.id,
      contactId,
      assignedToId: inheritAssignee,
    });
    emitConversationCreated({
      contactId,
      channel: platform,
      channelId,
      conversationId: created.id,
      source: "inbound_messaging",
      extra: openingMessageTriggerExtra({
        content: opening?.content,
        messageType: opening?.messageType,
      }),
    });
    return {
      id: created.id,
      assignedToId: created.assignedToId ?? inheritAssignee,
    };
  } catch (err) {
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findOnAccount(channelId);
      if (won) return { id: won.id, assignedToId: won.assignedToId ?? null };
    }
    throw err;
  }
}
