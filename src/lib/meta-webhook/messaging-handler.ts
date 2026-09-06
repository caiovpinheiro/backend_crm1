/**
 * Handler dos webhooks de mensageria da Meta:
 *   - object === "page"      -> Facebook Messenger
 *   - object === "instagram" -> Instagram Direct
 *
 * Payload Messenger: `entry[].messaging[]`.
 * Payload Instagram Login (messages): `entry[].changes[].value` com
 * `from.id` / `message` string — NAO so `entry[].messaging[]`.
 * Identidade do canal: `entry.id` (= IGSID / pageId).
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { createMessageDedup } from "@/lib/message-dedup";
import { getOrgIdOrNull } from "@/lib/request-context";
import { CRM_META_APP_SECRET } from "@/lib/meta-constants";
import { verifyMetaWebhookSignature } from "@/lib/meta-webhook-signature";
import { decryptSecret, isEncryptedSecret } from "@/lib/crypto/secrets";
import { sseBus } from "@/lib/sse-bus";
import { onInboundMessageForAi } from "@/services/ai/turn-manager";
import {
  isActiveConversationUniqueViolation,
  withConversationNumberRetry,
} from "@/services/conversations";
import { maybeDistributeNewInboundTicket } from "@/services/distribution";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import { sanitizeContactName } from "@/lib/display-name";
import { notifyInboundMessage } from "@/lib/web-push";
import { touchInbound, warnTouchInboundFailed } from "@/lib/conversation-inbound";
import { getLogger } from "@/lib/logger";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
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
  opts?: { skipSignature?: boolean },
): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const secrets = messagingWebhookSecrets();
  if (!opts?.skipSignature) {
    if (secrets.length > 0) {
      const signatureValid = secrets.some((s) =>
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
  for (const entry of entries) {
    try {
      await processEntry(entry, platform);
    } catch (err) {
      log.error("Erro ao processar entry (nao-fatal):", err);
    }
  }

  return NextResponse.json({ status: "ok" });
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
  const channelLabel = platform === "instagram" ? "Instagram" : "Messenger";
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

  const conversation = await findOrCreateConversation(contact.id, platform, hit.channelId);

  // Anexos: guardamos o primeiro URL como preview no `content` quando nao ha texto.
  let content = text;
  const firstAttachment = ev.message?.attachments?.[0];
  if (!content && firstAttachment) {
    const url = firstAttachment.payload?.url;
    const type = firstAttachment.type || "attachment";
    content = url ? `[${type}] ${url}` : `[${type}]`;
  }

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
    sseBus.publish("new_message", {
      organizationId: getOrgIdOrNull(),
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "in",
      assignedToId: conversation.assignedToId ?? null,
      content,
      timestamp,
    });
  } catch (err) {
    log.debug("SSE publish falhou (nao-fatal):", err);
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

async function fetchProfileName(
  userId: string,
  hit: ChannelHit,
): Promise<string | null> {
  if (!hit.accessToken) return null;
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
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string; username?: string };
    return data.name?.trim() || data.username?.trim() || null;
  } catch {
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
): Promise<{ id: string; assignedToId: string | null }> {
  const channelSlug = platform;

  const findActive = () =>
    prisma.conversation.findFirst({
      where: { contactId, channel: channelSlug, status: { not: "RESOLVED" } },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, channelId: true, assignedToId: true },
    });

  const existing = await findActive();
  if (existing) {
    if (existing.channelId !== channelId) {
      await prisma.conversation.update({
        where: { id: existing.id },
        data: { channelId },
      });
    }
    return { id: existing.id, assignedToId: existing.assignedToId ?? null };
  }

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { assignedToId: true },
  });

  try {
    const created = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          contactId,
          channel: channelSlug,
          channelId,
          status: "OPEN" as const,
          ...(contact?.assignedToId ? { assignedToId: contact.assignedToId } : {}),
        }),
        select: { id: true, assignedToId: true },
      }),
    );
    await maybeDistributeNewInboundTicket({
      conversationId: created.id,
      contactId,
      assignedToId: contact?.assignedToId ?? null,
    });
    return {
      id: created.id,
      assignedToId: created.assignedToId ?? contact?.assignedToId ?? null,
    };
  } catch (err) {
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findActive();
      if (won) return { id: won.id, assignedToId: won.assignedToId ?? null };
    }
    throw err;
  }
}
