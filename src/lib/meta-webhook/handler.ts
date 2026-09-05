import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { phoneMatchVariants } from "@/lib/phone";
import { CRM_META_APP_SECRET } from "@/lib/meta-constants";
import {
  insertContactWithNextNumber,
  isContactBsuidUniqueViolation,
} from "@/services/contacts";
import {
  isActiveConversationUniqueViolation,
  withConversationNumberRetry,
} from "@/services/conversations";
import { maybeDistributeNewInboundTicket } from "@/services/distribution";
import { verifyMetaWebhookSignature } from "@/lib/meta-webhook-signature";
import { decryptSecret, isEncryptedSecret } from "@/lib/crypto/secrets";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { enqueueMetaWebhookEvent } from "@/lib/queue";
import { cache } from "@/lib/cache";
import { touchInbound, warnTouchInboundFailed } from "@/lib/conversation-inbound";

/**
 * Scope multi-tenancy do webhook. Quando presente:
 *   - GET valida verifyToken contra Channel.config.verifyToken DESSA org
 *   - POST valida appSecret contra Channel.config.appSecret DESSA org
 *   - Toda a logica de processamento roda dentro de withSystemContext(orgId)
 *     -> Prisma extension filtra todas as queries por organizationId
 *     -> impossivel vazar cross-org
 *
 * Quando ausente (rota legacy /api/webhooks/meta sem slug):
 *   - GET valida META_WEBHOOK_VERIFY_TOKEN env (compartilhado)
 *   - POST valida appSecret contra TODOS os canais Meta (any-match)
 *   - Sem context (deprecated; ver doc/onboarding-meta-cliente.md)
 */
export type WebhookScope = {
  organizationId: string;
  organizationSlug: string;
};
import { sseBus } from "@/lib/sse-bus";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  maybeDenyWhatsappCallConsent,
  maybeGrantWhatsappCallConsent,
} from "@/services/whatsapp-call-consent-webhook";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { resolveAdAndPersistAsync } from "@/services/meta-ad-resolver";
import { scheduleAiReply } from "@/services/ai/inbound-debounce";
import { ensureInboundAiAttendance } from "@/services/ai/first-attendance";
import { ensureOpenDealForContact } from "@/services/auto-deals";
import { sanitizeContactName } from "@/lib/display-name";
import { getLogger } from "@/lib/logger";
import { isRetiredMetaPhoneNumberId } from "@/lib/channels/retired-whatsapp";

// Marcador único de build — usado pra confirmar via `grep` no bundle se o
// rebuild do Easypanel pegou esta versão do source. Não tem outra função.
const META_WEBHOOK_BUILD_MARKER = "BUILD_2026_05_14_T_20_36_FLOW_FIX_ACTIVE";
void META_WEBHOOK_BUILD_MARKER;

const log = getLogger("meta-webhook");
import { processMetaWhatsappCallsWebhook } from "@/services/meta-whatsapp-calls-webhook";
import { processIncomingMessage as processSalesbotMessage } from "@/services/automation-context";
import { logEvent, logMessageFailed, logMessageRead } from "@/services/activity-log";
import { metaErrorReason, isMetaNonConversationErrorCode } from "@/lib/meta-whatsapp/error-catalog";
import { notifyInboundMessage } from "@/lib/web-push";
import { handleMessagingWebhookPost } from "@/lib/meta-webhook/messaging-handler";
import { asMetaId, configMetaIds } from "@/lib/meta-webhook/messaging-payload";
import { cancelPendingForConversation } from "@/services/scheduled-messages";
import { markCampaignReplyByContact } from "@/services/campaigns";
import {
  incrementCampaignCounter,
  type CampaignCounterField,
} from "@/lib/campaign-counters";
import {
  bufferMessageStatus,
  bufferRecipientStatus,
  isStatusWriteBufferEnabled,
} from "@/lib/status-write-buffer";
import {
  formatWhatsappFlowResponse,
  parseWhatsappFlowResponsePayload,
} from "@/lib/meta-whatsapp/parse-flow-response";
import { applyWhatsappFlowResponseToContact } from "@/services/whatsapp-flow-response";

type ReferralInfo = {
  sourceId: string | null;
  sourceType: string | null;
  ctwaClid: string | null;
  headline: string | null;
  body: string | null;
  sourceUrl: string | null;
};

// Token de verificação do webhook Meta. Sem fallback hardcoded — se não
// estiver configurado em produção, o GET de verificação responde 503 e o
// admin é forçado a configurar o env (evita "esquecer" e ficar com token
// padrão público no GitHub).
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || "";

// Exige assinatura valida sempre que NAO estamos em dev local. Antes
// esta flag so exigia em `production`, o que deixava staging/preview
// aceitando webhooks sem assinatura — um atacante podia forjar payload
// "do Meta" e injetar mensagens/contatos/automations em qualquer
// ambiente pre-prod exposto na internet.
const REQUIRE_SIGNATURE =
  process.env.NODE_ENV !== "development" || !!process.env.CI_STAGING;

/**
 * Processamento assíncrono do webhook Meta (default ligado).
 * A API valida assinatura + persiste MetaWebhookEvent + enfileira e
 * responde 200 imediatamente; o `worker-meta-webhook` executa o loop
 * pesado (status de campanha + mensagens) fora do processo do inbox.
 * `META_WEBHOOK_ASYNC=0` volta ao comportamento síncrono (rollback).
 */
const META_WEBHOOK_ASYNC = process.env.META_WEBHOOK_ASYNC !== "0";

const recentlyProcessed = new Map<string, number>();
const DEDUP_TTL = 30_000;

function isDuplicate(waMessageId: string): boolean {
  const now = Date.now();
  if (recentlyProcessed.size > 500) {
    for (const [k, t] of recentlyProcessed) {
      if (now - t > DEDUP_TTL) recentlyProcessed.delete(k);
    }
  }
  if (recentlyProcessed.has(waMessageId)) return true;
  recentlyProcessed.set(waMessageId, now);
  return false;
}

// ── Helpers ──────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function parseReferral(message: Record<string, unknown>): ReferralInfo | null {
  const ref = obj(message.referral);
  if (Object.keys(ref).length === 0) return null;
  return {
    sourceId: str(ref.source_id) || null,
    sourceType: str(ref.source_type) || null,
    ctwaClid: str(ref.ctwa_clid) || null,
    headline: str(ref.headline) || null,
    body: str(ref.body) || null,
    sourceUrl: str(ref.source_url) || null,
  };
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("55") ? `+${digits}` : `+${digits}`;
}

// ── WhatsApp "system" events: troca de número do cliente ─────────
//
// A Meta dispara `messages[].type = "system"` com `system.type` igual
// a `user_changed_number` (ou `customer_identity_changed` em algumas
// versões) quando o cliente migra o WhatsApp pra um novo telefone
// preservando o **mesmo BSUID** (`user_id`). O `wa_id` no payload é
// o NOVO número; o `body` traz a mensagem humana com os dois números
// (ex.: "USER A CHANGED FROM 5511982063029 TO 5511951624721").
//
// Este helper extrai os dois números e o BSUID novo a partir do payload
// raw, retorna `null` se não for um evento de troca relevante.
//
// Ref: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/system
type SystemEventInfo = {
  kind: "user_changed_number";
  oldPhone: string | null;
  newPhone: string | null;
  newBsuid: string | null;
  rawBody: string;
};

function extractSystemEvent(rawMessage: Record<string, unknown>): SystemEventInfo | null {
  const sys = obj(rawMessage.system);
  const sysType = str(sys.type).toLowerCase();
  const body = str(sys.body);

  // Tipos conhecidos da Meta que indicam "mesmo cliente, novo número".
  // `customer_identity_changed` aparece em payloads mais novos; aceitamos
  // os dois pra resiliência (a Meta já trocou o nome desse evento uma vez).
  const isNumberChange =
    sysType === "user_changed_number" ||
    sysType === "customer_identity_changed" ||
    /\bchanged\s+from\b.+\bto\b/i.test(body);

  if (!isNumberChange) return null;

  // Tentativa 1: parsear "FROM <old> TO <new>" do body (formato canônico
  // que a Meta envia em inglês mesmo pra contas pt-BR).
  let oldPhone: string | null = null;
  let newPhone: string | null = null;

  const m = body.match(/from\s+(\+?\d[\d\s-]{6,})\s+to\s+(\+?\d[\d\s-]{6,})/i);
  if (m) {
    const oldDigits = m[1].replace(/\D/g, "");
    const newDigits = m[2].replace(/\D/g, "");
    if (oldDigits.length >= 8) oldPhone = normalizePhone(oldDigits);
    if (newDigits.length >= 8) newPhone = normalizePhone(newDigits);
  }

  // Tentativa 2: fallback para campos estruturados (alguns payloads da
  // Meta trazem os WAIDs em `system.wa_id` (novo) e `m.from` (antigo)).
  if (!newPhone) {
    const sysWa = str(sys.wa_id);
    if (sysWa.replace(/\D/g, "").length >= 8) newPhone = normalizePhone(sysWa);
  }
  if (!oldPhone) {
    const fromWa = str(rawMessage.from);
    if (fromWa && fromWa !== str(sys.wa_id) && fromWa.replace(/\D/g, "").length >= 8) {
      oldPhone = normalizePhone(fromWa);
    }
  }

  const newBsuid = str(sys.user_id) || null;

  return {
    kind: "user_changed_number",
    oldPhone,
    newPhone,
    newBsuid,
    rawBody: body,
  };
}

/**
 * Processa um evento de troca de número:
 *  1. Atualiza `contact.phone` (e `whatsappBsuid`, se faltava) — o
 *     contato preserva todo o histórico (mesma row, mesmas conversas,
 *     deals, notas, atividades).
 *  2. Grava um registro imutável em `contact_phone_changes` pra
 *     auditoria + relatório agregado.
 *  3. Publica `contact_updated` no SSE bus pra UI atualizar o painel
 *     lateral em tempo real.
 *
 * Idempotente: se já existe um log com o mesmo `messageExternalId`,
 * não faz nada (segurança contra reentrega do webhook).
 */
async function applyContactPhoneChange(params: {
  contactId: string;
  currentPhone: string | null;
  currentBsuid: string | null;
  currentName: string | null;
  event: SystemEventInfo;
  messageExternalId: string;
}): Promise<{ updatedPhone: string | null; logged: boolean }> {
  const { contactId, currentPhone, currentBsuid, currentName, event, messageExternalId } = params;

  const existingLog = await prisma.contactPhoneChange.findFirst({
    where: { messageExternalId },
    select: { id: true },
  });
  if (existingLog) return { updatedPhone: currentPhone, logged: false };

  // Se o body não trouxe `from` (raro), assume o telefone atual do
  // contato como antigo — assim ainda registramos a transição.
  const oldPhone = event.oldPhone ?? currentPhone;
  const newPhone = event.newPhone;

  const contactUpdates: { phone?: string; whatsappBsuid?: string; name?: string } = {};
  if (newPhone && newPhone !== currentPhone) {
    contactUpdates.phone = newPhone;
  }
  if (event.newBsuid && !currentBsuid) {
    contactUpdates.whatsappBsuid = event.newBsuid;
  }

  // Quando o nome ainda é o auto-gerado "Lead +<oldphone>" / "Lead <oldphone>"
  // (porque o cliente nunca teve perfil capturado), atualizamos pra
  // refletir o novo telefone — caso contrário a inbox fica mostrando o
  // número antigo no título do card mesmo após a troca, como se fosse
  // um lead diferente. Nomes definidos pelo operador (qualquer coisa que
  // não case com o pattern auto) são preservados.
  if (newPhone && currentName && oldPhone) {
    const oldDigitsOnly = oldPhone.replace(/\D/g, "");
    const autoNamePattern = new RegExp(
      `^Lead\\s*\\+?${oldDigitsOnly}\\s*$`,
      "i",
    );
    if (autoNamePattern.test(currentName)) {
      contactUpdates.name = `Lead ${newPhone}`;
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(contactUpdates).length > 0) {
        await tx.contact.update({
          where: { id: contactId },
          data: contactUpdates,
        });
      }
      await tx.contactPhoneChange.create({
        data: withOrgFromCtx({
          contactId,
          oldPhone,
          newPhone,
          oldBsuid: currentBsuid,
          newBsuid: event.newBsuid,
          source: "WHATSAPP_SYSTEM" as const,
          rawSystemBody: event.rawBody || null,
          messageExternalId,
        }),
      });
    });
  } catch (err) {
    // P2002 = violação de unicidade. Acontece quando duas réplicas
    // processam o mesmo wamid em paralelo. A segunda é a duplicada e
    // pode ser ignorada — o contato já foi atualizado e o log já existe.
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      log.debug(
        `applyContactPhoneChange: duplicata por race (${messageExternalId}) — ignorando`,
      );
      return { updatedPhone: contactUpdates.phone ?? currentPhone, logged: false };
    }
    throw err;
  }

  try {
    sseBus.publish("contact_updated", {
      organizationId: getOrgIdOrNull(),
      contactId,
      reason: "phone_changed",
      oldPhone,
      newPhone,
    });
  } catch {
    // SSE é best-effort — log do banco já está consistente.
  }

  log.info(`Contato ${contactId} trocou de número: ${oldPhone ?? "?"} → ${newPhone ?? "?"}`);

  return { updatedPhone: contactUpdates.phone ?? currentPhone, logged: true };
}

// ── Contact resolution ───────────────────────────

type CrmContact = {
  id: string;
  name: string;
  phone: string | null;
  whatsappBsuid: string | null;
  whatsappUsername: string | null;
};

type ContactRow = {
  id: string;
  name: string;
  phone: string | null;
  whatsappBsuid: string | null;
  whatsappUsername: string | null;
};

/**
 * Resolve contato a partir do webhook Meta, com BSUID (user_id / from_user_id) e/ou telefone (wa_id / from).
 * Ref: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
 */
function ignoredMetaPhoneNumberIds(): Set<string> {
  const raw = process.env.META_IGNORE_PHONE_NUMBER_IDS ?? "";
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function shouldDropMetaInbound(phoneNumberId: string): boolean {
  return (
    isRetiredMetaPhoneNumberId(phoneNumberId) ||
    ignoredMetaPhoneNumberIds().has(phoneNumberId)
  );
}

function staleInboundMaxAgeMs(): number {
  const raw = Number.parseFloat(
    process.env.META_STALE_INBOUND_MAX_AGE_HOURS ?? "2",
  );
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 2;
  return hours * 60 * 60 * 1000;
}

function isStaleMetaInbound(timestamp: Date): boolean {
  const age = Date.now() - timestamp.getTime();
  return Number.isFinite(age) && age > staleInboundMaxAgeMs();
}

async function isKnownPhoneNumberId(phoneNumberId: string): Promise<boolean> {
  const envPhoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (envPhoneId && phoneNumberId === envPhoneId) return true;

  const channels = await prisma.channel.findMany({
    where: { type: "WHATSAPP", provider: "META_CLOUD_API" },
    select: { config: true },
  });
  for (const ch of channels) {
    const cfg = ch.config as Record<string, unknown> | null;
    if (cfg && String(cfg.phoneNumberId ?? "").trim() === phoneNumberId) return true;
  }
  return false;
}

async function findChannelByPhoneNumberId(phoneNumberId?: string) {
  if (!phoneNumberId) return null;
  // Lookup pelo id da Meta no JSON — igual ao createMetaWebhookEvent.
  // Nao filtra type/provider: um reconnect nao pode "sumir" o canal se
  // o provider no banco divergir. Preferir CONNECTED se houver duplicata
  // (linha velha DISCONNECTED + linha religada).
  const channels = await prisma.channel.findMany({
    where: {
      OR: [
        { config: { path: ["phoneNumberId"], equals: phoneNumberId } },
        { phoneNumber: phoneNumberId },
      ],
    },
    select: {
      id: true,
      name: true,
      status: true,
      phoneNumber: true,
      config: true,
    },
  });
  if (channels.length === 0) return null;
  return channels.find((ch) => ch.status === "CONNECTED") ?? channels[0];
}

async function getChannelSourceName(phoneNumberId?: string): Promise<string> {
  const channel = await findChannelByPhoneNumberId(phoneNumberId);
  if (!channel) return "WhatsApp";
  const cfg = channel.config as Record<string, unknown> | null;
  const appName = typeof cfg?.appName === "string" ? cfg.appName.trim() : "";
  return appName || channel.name || "WhatsApp";
}

// ── Reply & Reaction helpers ─────────────────────────────────────
//
// Estas duas funções sustentam o UX estilo WhatsApp de citação e
// reações no CRM. Elas rodam DENTRO de withSystemContext(orgId), então
// a Prisma extension já escopa por organização automaticamente.

type ReactionEntry = {
  emoji: string;
  from: string;      // wa_id / bsuid do reator
  at: string;        // ISO timestamp
};

/**
 * Aplica uma reação inbound ao Message alvo (identificado pelo wamid).
 * `emoji === null` remove a reação daquele contato. Idempotente: reagir
 * de novo com o mesmo emoji substitui o timestamp.
 */
async function applyIncomingReaction(params: {
  targetWaMessageId: string;
  emoji: string | null;
  fromWaId: string;
  at: Date;
}): Promise<void> {
  const { targetWaMessageId, emoji, fromWaId, at } = params;
  if (!targetWaMessageId || !fromWaId) return;

  const target = await prisma.message.findFirst({
    where: { externalId: targetWaMessageId },
    select: { id: true, reactions: true },
  });
  if (!target) {
    log.debug(
      `Reação recebida para wamid desconhecido (${targetWaMessageId}) — ignorando.`,
    );
    return;
  }

  const current: ReactionEntry[] = Array.isArray(target.reactions)
    ? (target.reactions as unknown as ReactionEntry[]).filter(
        (r) => r && typeof r === "object" && typeof r.emoji === "string" && typeof r.from === "string",
      )
    : [];

  // Cliente sempre tem no máximo 1 reação por mensagem (regra do WhatsApp).
  // Removemos qualquer entrada anterior desse `from` antes de adicionar.
  const withoutFrom = current.filter((r) => r.from !== fromWaId);
  const next = emoji
    ? [...withoutFrom, { emoji, from: fromWaId, at: at.toISOString() }]
    : withoutFrom;

  await prisma.message.update({
    where: { id: target.id },
    data: { reactions: next as unknown as object[] },
  });
}

/**
 * Resolve o alvo de uma citação. Retorna { messageId, preview } quando
 * a Meta mandou `context.id` e encontramos o Message correspondente no
 * CRM. `preview` é um snapshot curto (~120 chars) do conteúdo, servido
 * como fallback para desenhar a citação sem precisar de novo JOIN no
 * frontend.
 */
async function resolveReplyContext(
  waMessageId: string,
): Promise<{ messageId: string; preview: string } | null> {
  const target = await prisma.message.findFirst({
    where: { externalId: waMessageId },
    select: { id: true, content: true },
  });
  if (!target) return null;
  const preview = (target.content ?? "").trim().slice(0, 120);
  return { messageId: target.id, preview };
}

async function resolveWebhookContact(
  waIdRaw: string | undefined,
  bsuidRaw: string | undefined,
  profileName: string | null,
  phoneNumberId?: string,
  opts?: { username?: string | null },
): Promise<CrmContact>;
async function resolveWebhookContact(
  waIdRaw: string | undefined,
  bsuidRaw: string | undefined,
  profileName: string | null,
  phoneNumberId: string | undefined,
  opts: { createIfMissing: false; username?: string | null },
): Promise<CrmContact | null>;
async function resolveWebhookContact(
  waIdRaw: string | undefined,
  bsuidRaw: string | undefined,
  profileName: string | null,
  phoneNumberId?: string,
  opts: { createIfMissing?: boolean; username?: string | null } = {},
): Promise<CrmContact | null> {
  const createIfMissing = opts.createIfMissing !== false;
  const username = opts.username?.trim().replace(/^@/, "") || undefined;
  const bsuid = bsuidRaw?.trim() || undefined;
  let phone: string | null = null;
  if (waIdRaw) {
    const digits = waIdRaw.replace(/\D/g, "");
    if (digits.length >= 8) {
      phone = normalizePhone(waIdRaw);
    }
  }

  if (!phone && !bsuid) {
    throw new Error("resolveWebhookContact: sem identificador wa_id nem BSUID");
  }

  let byBs: ContactRow | null = null;
  if (bsuid) {
    byBs = await prisma.contact.findFirst({
      where: { whatsappBsuid: bsuid },
      select: { id: true, name: true, phone: true, whatsappBsuid: true, whatsappUsername: true },
    });
  }

  let byPh: ContactRow | null = null;
  if (phone) {
    // Match por variantes E.164 (cobre com/sem 9º dígito BR). Já é
    // org-scoped pela extensão do Prisma dentro de withSystemContext.
    const variants = phoneMatchVariants(phone);
    byPh = await prisma.contact.findFirst({
      where: variants.length > 0 ? { phone: { in: variants } } : { phone },
      select: { id: true, name: true, phone: true, whatsappBsuid: true, whatsappUsername: true },
    });
  }

  let contactRow: ContactRow | null = null;

  if (byBs && byPh) {
    if (byBs.id === byPh.id) {
      contactRow = byBs;
    } else {
      log.warn(`BSUID e telefone em contatos diferentes — priorizando BSUID (${bsuid})`);
      contactRow = byBs;
    }
  } else if (byBs) {
    contactRow = byBs;
  } else if (byPh) {
    contactRow = byPh;
  }

  if (!contactRow && phone) {
    // Fallback para bases legadas ainda NÃO normalizadas (telefone gravado
    // fora do E.164). Filtra por sufixo dos 8 dígitos do assinante — que é
    // idêntico com ou sem o 9º dígito — e confirma pela comparação de
    // variantes (que reintroduz o DDD, evitando colisão entre DDDs). Sem o
    // antigo `take: 500`, que fazia o match silenciosamente incompleto em
    // orgs grandes; `endsWith` mantém o conjunto de candidatos pequeno.
    const digits = phone.replace(/\D/g, "");
    const last8 = digits.slice(-8);
    if (last8.length === 8) {
      const variantSet = new Set(phoneMatchVariants(phone));
      const candidates = await prisma.contact.findMany({
        where: { phone: { endsWith: last8 } },
        select: { id: true, name: true, phone: true, whatsappBsuid: true, whatsappUsername: true },
      });
      const byFuzzy = candidates.find((c) =>
        phoneMatchVariants(c.phone).some((v) => variantSet.has(v)),
      );
      if (byFuzzy) contactRow = byFuzzy;
    }
  }

  // Fallback por `profile.name` REMOVIDO em 2026-06-30.
  //
  // Histórico: havia um terceiro fallback aqui — se BSUID/phone/fuzzy-phone
  // não casassem, fazia `findFirst({ name: equals(profileName) })`. A ideia
  // era recuperar contatos importados sem phone, mas o efeito real em
  // produção foi catastrófico para orgs com funil de recrutamento (DNAWork):
  // qualquer pessoa com `profile.name = "Mari"` (ou "Eduardo", "Kauã", etc.)
  // tinha suas mensagens grudadas no PRIMEIRO contato existente com aquele
  // nome — mesmo sendo um número totalmente diferente.
  //
  // Diagnóstico: 1.801 inbounds mal-roteadas em 30 dias na DNAWork,
  // afetando 429 conversas. Sintoma reportado: composer responde para o
  // phone gravado no contato (correto), mas Meta retorna `131047 Fora da
  // janela de 24h` porque o NÚMERO REAL daquele contato não enviou nada
  // — quem enviou foi outra pessoa que caiu na mesma conversa por
  // homonímia. Ver investigação em `_diag/decode_wamids.py` /
  // `_diag/estimate_damage.py` no workspace.
  //
  // Decisão: `wa_id` (E.164) é a fonte de verdade no protocolo Meta —
  // fallback por nome é fundamentalmente inseguro em qualquer escala.
  // Sem este match, números novos passam a criar contatos novos
  // (comportamento correto). Saneamento dos dados já bagunçados não é
  // feito aqui (migration separada, fora deste escopo).

  if (contactRow) {
    const updates: {
      name?: string;
      phone?: string | null;
      whatsappBsuid?: string;
      whatsappUsername?: string;
    } = {};
    if (profileName && contactRow.name.startsWith("Lead +")) {
      updates.name = sanitizeContactName(profileName) || profileName;
    } else {
      // Contatos antigos com emoji no nome: limpa na próxima mensagem.
      const cleaned = sanitizeContactName(contactRow.name);
      if (cleaned && cleaned !== contactRow.name) {
        updates.name = cleaned;
      }
    }
    if (phone && !contactRow.phone) {
      updates.phone = phone;
    }
    if (bsuid && !contactRow.whatsappBsuid) {
      updates.whatsappBsuid = bsuid;
    }
    // Backfill do @ do WhatsApp: grava sempre que o payload trouxer o
    // username e o valor mudou (o cliente pode ter adotado/trocado).
    if (username && contactRow.whatsappUsername !== username) {
      updates.whatsappUsername = username;
    }
    if (Object.keys(updates).length > 0) {
      prisma.contact
        .update({ where: { id: contactRow.id }, data: updates })
        .catch(() => {});
      contactRow = { ...contactRow, ...updates };
    }

    // Contato JÁ EXISTE: a função só auto-cria deal se ele nunca tiver
    // tido um (raro — ex.: contato importado sem deal). Se já houve
    // OPEN/WON/LOST, NÃO recria — o controle passa pras automações
    // configuradas pelo operador (trigger `message_received` com
    // filtro `dealStatus`). Isso evita re-disparar `deal_created` em
    // leads descartados ou clientes que já compraram. Ver `auto-deals.ts`
    // (changelog v3 — jun/2026).
    const existingRoutingChannelId =
      (await findChannelByPhoneNumberId(phoneNumberId))?.id ?? null;
    ensureOpenDealForContact({
      contactId: contactRow.id,
      contactName: contactRow.name,
      source: "auto_whatsapp",
      logTag: "meta-webhook",
      channelId: existingRoutingChannelId,
    }).catch((err) =>
      log.warn("Falha ao garantir deal aberto:", err),
    );

    return {
      id: contactRow.id,
      name: contactRow.name,
      phone: contactRow.phone ?? null,
      whatsappBsuid: contactRow.whatsappBsuid ?? null,
      whatsappUsername: contactRow.whatsappUsername ?? null,
    };
  }

  if (!createIfMissing) {
    log.debug(
      `resolveWebhookContact: contato não encontrado e createIfMissing=false — não criando lead`,
    );
    return null;
  }

  const name =
    (profileName ? sanitizeContactName(profileName) || profileName : null) ||
    (phone ? `Lead ${phone}` : `Lead WhatsApp (${(bsuid ?? "").slice(0, 18)}…)`);

  const sourceName = await getChannelSourceName(phoneNumberId);

  const contactSelect = {
    id: true,
    name: true,
    phone: true,
    whatsappBsuid: true,
    whatsappUsername: true,
  } as const;

  let created: {
    id: string;
    name: string;
    phone: string | null;
    whatsappBsuid: string | null;
    whatsappUsername: string | null;
  };
  try {
    created = await insertContactWithNextNumber(
      {
        name,
        ...(phone ? { phone } : {}),
        ...(bsuid ? { whatsappBsuid: bsuid } : {}),
        ...(username ? { whatsappUsername: username } : {}),
        lifecycleStage: "LEAD" as const,
        source: sourceName,
      },
      contactSelect,
    );
  } catch (err) {
    // Corrida: outro webhook já inseriu o mesmo BSUID — reusa o vencedor
    // (retry cego com novo number não resolve unique de bsuid).
    if (isContactBsuidUniqueViolation(err) && bsuid) {
      const won = await prisma.contact.findFirst({
        where: { whatsappBsuid: bsuid },
        select: contactSelect,
      });
      if (won) {
        return {
          id: won.id,
          name: won.name,
          phone: won.phone ?? null,
          whatsappBsuid: won.whatsappBsuid ?? null,
          whatsappUsername: won.whatsappUsername ?? null,
        };
      }
    }
    throw err;
  }

  // Dispara automações com trigger "contact_created" (fire-and-forget,
  // não bloqueia a resposta ao webhook da Meta, que tem janela curta
  // de retry). Precisa acontecer ANTES do auto-deal para preservar a
  // ordem semântica (contato criado → deal criado).
  fireTrigger("contact_created", {
    contactId: created.id,
    data: { source: sourceName, channel: "WhatsApp" },
  }).catch((err) =>
    log.warn("Falha no gatilho contact_created:", err),
  );

  ensureOpenDealForContact({
    contactId: created.id,
    contactName: name,
    source: "auto_whatsapp",
    logTag: "meta-webhook",
    channelId: (await findChannelByPhoneNumberId(phoneNumberId))?.id ?? null,
  }).catch((err) =>
    log.warn("Falha ao garantir deal aberto:", err),
  );

  log.info(`Novo lead: ${name} (${phone ?? bsuid})`);
  return {
    id: created.id,
    name: created.name,
    phone: created.phone ?? null,
    whatsappBsuid: created.whatsappBsuid ?? null,
    whatsappUsername: created.whatsappUsername ?? null,
  };
}

// A lógica de auto-criação de deal foi extraída para
// `src/services/auto-deals.ts` e agora é chamada TANTO quando o contato é
// novo quanto quando um contato pré-existente volta a falar — assim
// contatos importados/manuais sem deal passam a ter um ao primeiro
// inbound.

async function findOrCreateConversation(contactId: string, phoneNumberId?: string) {
  const targetChannel = await findChannelByPhoneNumberId(phoneNumberId);

  // Modelo de ticket: contatos com conversa RESOLVED geram NOVA conversa
  // na proxima mensagem inbound (nao reabre). Ver AGENT.md.
  const convSelect = {
    id: true,
    status: true,
    channelId: true,
    organizationId: true,
    assignedToId: true,
  } as const;
  const findActive = () =>
    prisma.conversation.findFirst({
      where: { contactId, channel: "whatsapp", status: { not: "RESOLVED" } },
      // Sem orderBy o Postgres devolve o ticket mais antigo. Ligação
      // gravada lá faz o inbox (1 card / contato) saltar para esse id
      // e o chat do ticket atual some da timeline.
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: convSelect,
    });

  const existing = await findActive();

  if (existing) {
    // Reusa a conversa aberta. So reconcilia canal (para o inbox mostrar
    // que a mensagem entrou pela conta X). Nao promove status pra OPEN
    // porque agora a conversa ja e' non-RESOLVED por construcao.
    if (targetChannel && existing.channelId !== targetChannel.id) {
      await prisma.conversation.update({
        where: { id: existing.id },
        data: { channelId: targetChannel.id },
      });
    }
    return { ...existing, channelId: targetChannel?.id ?? existing.channelId };
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
          channel: "whatsapp",
          channelId: targetChannel?.id,
          status: "OPEN" as const,
          ...(contact?.assignedToId ? { assignedToId: contact.assignedToId } : {}),
        }),
        select: convSelect,
      }),
    );
    // Novo ticket após RESOLVED: redistribui se ainda sem responsável.
    await maybeDistributeNewInboundTicket({
      conversationId: created.id,
      contactId,
      assignedToId: contact?.assignedToId ?? null,
    });
    return created;
  } catch (err) {
    // Corrida: dois webhooks/mensagens simultaneos do mesmo numero. O
    // indice unico parcial rejeita o 2o create com P2002 — reusa o
    // ticket vencedor em vez de duplicar.
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findActive();
      if (won) return { ...won, channelId: targetChannel?.id ?? won.channelId };
    }
    throw err;
  }
}

// ── Extract message content ──────────────────────

type ParsedMessage = {
  waMessageId: string;
  timestamp: Date;
  type: string;
  text: string;
  mediaUrl: string | null;
  mediaId: string | null;
  mimeType: string | null;
  /**
   * Quando o cliente responde uma mensagem específica no WhatsApp, o payload
   * traz `context.id` = wamid da mensagem citada. Usamos para popular
   * `Message.replyToId`/`replyToPreview` e desenhar a citação na bolha.
   */
  replyToWaMessageId: string | null;
  /**
   * Preenchido apenas quando `type === "reaction"`: o cliente reagiu (ou
   * removeu reação) numa mensagem enviada por nós. `emoji === null` sinaliza
   * remoção. `targetWaMessageId` é o wamid da mensagem reagida.
   *
   * Quando presente, o fluxo NÃO cria uma Message nova — apenas atualiza o
   * JSON `reactions` do Message alvo. Se o alvo não existir localmente
   * (raro; typicamente uma reação numa mensagem que ainda não foi
   * sincronizada), o evento é ignorado silenciosamente.
   */
  reactionTarget: { targetWaMessageId: string; emoji: string | null } | null;
  /** ID do botão/lista (interactive) — usado p.ex. para opt-in de chamada. */
  interactiveButtonId: string | null;
  interactiveButtonTitle: string | null;
  /** Valor de `interactive.type` na Cloud API (ex. button_reply, call_permission_reply). */
  interactiveKind: string | null;
  /**
   * Quando `interactive.type = call_permission_reply`, a Meta devolve o tipo
   * da permissão concedida: "permanent" ou "temporary" (também visto como
   * `permission_duration`). Usado para setar `whatsappCallConsentType` e
   * calcular o prazo de expiração (7 dias vs. indefinido).
   */
  callPermissionType: "PERMANENT" | "TEMPORARY" | null;
  referral: ReferralInfo | null;
  /** Payload bruto do WhatsApp Flow (nfm_reply) para gravar no lead. */
  flowPayload: Record<string, unknown> | null;
  flowMetaName: string | null;
  flowToken: string | null;
};

function fallbackUnknownInteractive(
  kind: string | null,
  inter: Record<string, unknown>
): string {
  for (const [key, val] of Object.entries(inter)) {
    if (key === "type") continue;
    const o = obj(val);
    const t = str(o.title) || str(o.description) || str(o.text) || str(o.name);
    if (t) return t;
    const id = str(o.id);
    if (id && kind) return `Seleção (${kind}): ${id}`;
  }
  if (kind) return `Resposta interativa (${kind})`;
  return "[interactive]";
}

/** Extrai texto legível de `messages[].interactive` (botões, lista, permissão de ligação, flow/NFM). */
function parseInteractiveBlock(inter: Record<string, unknown>): {
  text: string;
  interactiveKind: string | null;
  interactiveButtonId: string | null;
  interactiveButtonTitle: string | null;
  callPermissionType: "PERMANENT" | "TEMPORARY" | null;
  flowPayload: Record<string, unknown> | null;
  flowMetaName: string | null;
  flowToken: string | null;
} {
  const interactiveKind = str(inter.type) || null;

  const btnReply = obj(inter.button_reply);
  const listReply = obj(inter.list_reply);
  let interactiveButtonId = str(btnReply.id) || str(listReply.id) || null;
  let interactiveButtonTitle = str(btnReply.title) || str(listReply.title) || null;
  // list_reply traz title + description; o WhatsApp mostra os dois. Sem a
  // description o CRM gravava só o título (ex.: "Operador de Loja").
  const listReplyDescription = str(listReply.description);
  const interactiveDisplay =
    interactiveButtonTitle && listReplyDescription
      ? `${interactiveButtonTitle}\n${listReplyDescription}`
      : interactiveButtonTitle || listReplyDescription || null;

  let cpr = obj(inter.call_permission_reply);
  if (Object.keys(cpr).length === 0) cpr = obj(inter.call_permission);
  let fromCallPermission = "";
  let callPermissionType: "PERMANENT" | "TEMPORARY" | null = null;
  if (Object.keys(cpr).length > 0) {
    const resp = (
      str(cpr.response) ||
      str(cpr.call_permission_response) ||
      str(cpr.status) ||
      ""
    ).toUpperCase();
    const permType = (
      str(cpr.permission_type) ||
      str(cpr.permission_duration) ||
      ""
    ).toLowerCase();

    if (
      resp === "GRANTED" ||
      resp === "ACCEPT" ||
      resp === "ACCEPTED" ||
      resp === "APPROVED" ||
      resp === "ALLOW"
    ) {
      const isPermanent = permType.includes("permanent") || permType.includes("permanen");
      callPermissionType = isPermanent ? "PERMANENT" : "TEMPORARY";
      fromCallPermission = isPermanent
        ? "✅ Cliente aceitou: permissão permanente para ligações."
        : "✅ Cliente aceitou: permissão para ligações por 7 dias.";
    } else if (
      resp === "REJECT" ||
      resp === "REJECTED" ||
      resp === "DECLINE" ||
      resp === "DECLINED" ||
      resp === "DENY" ||
      resp === "DENIED" ||
      resp === "BLOCK" ||
      resp === "BLOCKED"
    ) {
      fromCallPermission = "❌ Cliente recusou o pedido de permissão para ligações.";
    } else if (resp || permType) {
      fromCallPermission = `📞 Resposta ao pedido de ligações: ${[resp, permType].filter(Boolean).join(" · ")}`;
    } else {
      const brief = Object.entries(cpr)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      fromCallPermission = brief
        ? `📞 Permissão de ligação (${brief.slice(0, 180)}${brief.length > 180 ? "…" : ""})`
        : "📞 Resposta ao pedido de permissão para ligações.";
    }
  }

  // Resposta de WhatsApp Flow vem em duas formas no webhook da Meta:
  //   1. `interactive.type = "nfm_reply"` (Native Form Message Reply — Cloud API)
  //   2. `interactive.type = "flow_reply"` (variante mais antiga, ainda vista)
  // Em ambos os casos, `body` literal vem "Sent" e os valores preenchidos
  // ficam em `response_json` (string JSON). Formatamos como "Campo: valor"
  // por linha pra que o operador leia direto no chat.
  let flowPayload: Record<string, unknown> | null = null;
  let flowMetaName: string | null = null;
  let flowToken: string | null = null;

  const nfm = obj(inter.nfm_reply);
  let fromNfm = "";
  if (Object.keys(nfm).length > 0) {
    // Log estruturado do payload bruto pra debugging — ajuda a entender
    // se Meta está mandando `response_json` ou apenas `body`. Em produção
    // estável esse log pode ser removido; mantido por enquanto pra dar
    // visibilidade sobre fluxos que ainda chegam vazios.
    log.info("[whatsapp-flow] nfm_reply recebido", {
      keys: Object.keys(nfm),
      name: str(nfm.name) || null,
      body: str(nfm.body) || null,
      response_json_type: typeof nfm.response_json,
      response_json_preview:
        typeof nfm.response_json === "string"
          ? nfm.response_json.slice(0, 500)
          : nfm.response_json
            ? JSON.stringify(nfm.response_json).slice(0, 500)
            : null,
    });
    const parsedFlow = parseWhatsappFlowResponsePayload(nfm);
    if (parsedFlow) {
      flowPayload = parsedFlow.payload;
      flowMetaName = parsedFlow.flowMetaName;
      flowToken = parsedFlow.flowToken;
    }
    if (!flowToken) flowToken = str(nfm.flow_token) || null;
    const formatted = formatWhatsappFlowResponse(nfm);
    if (formatted) {
      fromNfm = formatted;
    } else {
      const b = str(nfm.body);
      fromNfm = b && b.toLowerCase() !== "sent"
        ? `Fluxo (resposta): ${b.slice(0, 400)}${b.length > 400 ? "…" : ""}`
        : "📋 Resposta do formulário recebida (sem campos).";
    }
  }

  const flowReply = obj(inter.flow_reply);
  let fromFlow = "";
  if (Object.keys(flowReply).length > 0) {
    log.info("[whatsapp-flow] flow_reply recebido", {
      keys: Object.keys(flowReply),
      name: str(flowReply.name) || null,
      body: str(flowReply.body) || null,
      response_json_type: typeof flowReply.response_json,
      response_json_preview:
        typeof flowReply.response_json === "string"
          ? flowReply.response_json.slice(0, 500)
          : flowReply.response_json
            ? JSON.stringify(flowReply.response_json).slice(0, 500)
            : null,
    });
    const parsedFlow = parseWhatsappFlowResponsePayload(flowReply);
    if (parsedFlow) {
      flowPayload = parsedFlow.payload;
      flowMetaName = parsedFlow.flowMetaName ?? flowMetaName;
      flowToken = parsedFlow.flowToken ?? flowToken;
    }
    const formatted = formatWhatsappFlowResponse(flowReply);
    if (formatted) {
      fromFlow = formatted;
    } else {
      const body = str(flowReply.body);
      fromFlow = body && body.toLowerCase() !== "sent"
        ? `Fluxo: ${body.slice(0, 400)}${body.length > 400 ? "…" : ""}`
        : "📋 Resposta do formulário recebida (sem campos).";
    }
  }

  let text =
    interactiveDisplay ||
    fromCallPermission ||
    fromNfm ||
    fromFlow ||
    str(inter.body) ||
    "";

  if (!text && interactiveButtonId) {
    text = `Botão selecionado (id: ${interactiveButtonId})`;
  }

  if (!text) {
    text = fallbackUnknownInteractive(interactiveKind, inter);
  }

  return {
    text,
    interactiveKind,
    interactiveButtonId,
    interactiveButtonTitle,
    callPermissionType,
    flowPayload,
    flowMetaName,
    flowToken,
  };
}

/**
 * Rótulo legível para webhook `type: "unsupported"` (erro Meta 131051/131060).
 * O conteúdo real nunca chega — só o aviso.
 */
function labelUnsupportedMessage(message: Record<string, unknown>): string {
  const u = obj(message.unsupported);
  const subtype = str(u.type).toLowerCase();
  const errors = Array.isArray(message.errors) ? message.errors : [];
  const firstErr = obj(errors[0] as Record<string, unknown> | null);
  const code = typeof firstErr.code === "number" ? firstErr.code : Number(firstErr.code) || 0;

  if (code === 131060) {
    return "Mensagem indisponível (limitação da Meta)";
  }

  const bySubtype: Record<string, string> = {
    poll_creation: "Enquete (não suportada pela API da Meta)",
    poll_update: "Atualização de enquete (não suportada pela API da Meta)",
    edit: "Edição de mensagem (não suportada pela API da Meta)",
    gif: "GIF (não suportado pela API da Meta)",
    group_invite: "Convite de grupo (não suportado pela API da Meta)",
    media_placeholder: "Álbum de mídia (não suportado pela API da Meta)",
    // Álbum multi-imagem: Meta envia unsupported.type=image e depois as fotos 1 a 1
    image: "Álbum de imagens (não suportado pela API da Meta)",
    video: "Álbum de vídeos (não suportado pela API da Meta)",
    button: "Botão (não suportado neste contexto pela API da Meta)",
    interactive: "Interativo (não suportado neste contexto pela API da Meta)",
    list: "Lista (não suportada neste contexto pela API da Meta)",
    location: "Localização (não suportada neste contexto pela API da Meta)",
    order: "Pedido (não suportado pela API da Meta)",
    product: "Produto (não suportado pela API da Meta)",
    pin: "Mensagem fixada (não suportada pela API da Meta)",
    reaction: "Reação (formato não suportado pela API da Meta)",
    keep_in_chat: "Keep in chat (não suportado pela API da Meta)",
    link_preview: "Prévia de link (não suportada pela API da Meta)",
    hsm: "Template HSM (não suportado neste contexto)",
  };

  if (subtype && bySubtype[subtype]) return bySubtype[subtype];
  return "Tipo de mensagem não suportado pela API da Meta";
}

function parseMessage(message: Record<string, unknown>): ParsedMessage | null {
  const id = str(message.id);
  const ts = str(message.timestamp);
  const type = str(message.type);
  if (!id || !type) return null;

  const timestamp = ts
    ? new Date(Number(ts) * 1000)
    : new Date();

  let text = "";
  let mediaUrl: string | null = null;
  let mediaId: string | null = null;
  let mimeType: string | null = null;
  let interactiveButtonId: string | null = null;
  let interactiveButtonTitle: string | null = null;
  let interactiveKind: string | null = null;
  let callPermissionType: "PERMANENT" | "TEMPORARY" | null = null;
  let flowPayload: Record<string, unknown> | null = null;
  let flowMetaName: string | null = null;
  let flowToken: string | null = null;

  switch (type) {
    case "text": {
      const t = obj(message.text);
      text = str(t.body);
      break;
    }
    case "image": {
      const m = obj(message.image);
      text = str(m.caption) || "[Imagem]";
      mediaId = str(m.id) || null;
      mimeType = str(m.mime_type) || "image/jpeg";
      break;
    }
    case "video": {
      const m = obj(message.video);
      text = str(m.caption) || "[Vídeo]";
      mediaId = str(m.id) || null;
      mimeType = str(m.mime_type) || "video/mp4";
      break;
    }
    case "audio": {
      const m = obj(message.audio);
      text = "[Áudio]";
      mediaId = str(m.id) || null;
      mimeType = str(m.mime_type) || "audio/ogg";
      break;
    }
    case "document": {
      const m = obj(message.document);
      text = str(m.caption) || str(m.filename) || "[Documento]";
      mediaId = str(m.id) || null;
      mimeType = str(m.mime_type) || "application/octet-stream";
      break;
    }
    case "sticker": {
      text = "[Sticker]";
      const m = obj(message.sticker);
      mediaId = str(m.id) || null;
      mimeType = str(m.mime_type) || "image/webp";
      break;
    }
    case "location": {
      const m = obj(message.location);
      text = `📍 ${m.latitude}, ${m.longitude}`;
      break;
    }
    case "contacts": {
      text = "[Contato compartilhado]";
      break;
    }
    case "reaction": {
      // Reação do cliente numa mensagem nossa. Payload da Meta:
      //   { type: "reaction", reaction: { message_id, emoji } }
      // `emoji` vazio = cliente removeu a reação (WhatsApp permite).
      const r = obj(message.reaction);
      const targetWaMessageId = str(r.message_id);
      if (!targetWaMessageId) return null;
      const rawEmoji = str(r.emoji);
      // Cai para bloco de retorno abaixo com reactionTarget preenchido.
      // Marcamos o text para o log de debug; ele não é persistido.
      text = rawEmoji ? `Reagiu com ${rawEmoji}` : "Removeu reação";
      return {
        waMessageId: id,
        timestamp,
        type,
        text,
        mediaUrl: null,
        mediaId: null,
        mimeType: null,
        replyToWaMessageId: null,
        reactionTarget: {
          targetWaMessageId,
          emoji: rawEmoji || null,
        },
        interactiveButtonId: null,
        interactiveButtonTitle: null,
        interactiveKind: null,
        callPermissionType: null,
        referral: null,
        flowPayload: null,
        flowMetaName: null,
        flowToken: null,
      };
    }
    case "interactive": {
      const inter = obj(message.interactive);
      const parsedInter = parseInteractiveBlock(inter);
      text = parsedInter.text;
      interactiveKind = parsedInter.interactiveKind;
      interactiveButtonId = parsedInter.interactiveButtonId;
      interactiveButtonTitle = parsedInter.interactiveButtonTitle;
      callPermissionType = parsedInter.callPermissionType;
      flowPayload = parsedInter.flowPayload;
      flowMetaName = parsedInter.flowMetaName;
      flowToken = parsedInter.flowToken;
      break;
    }
    case "button": {
      const btn = obj(message.button);
      interactiveButtonId = str(btn.payload) || null;
      interactiveButtonTitle = str(btn.text) || null;
      text = interactiveButtonTitle || "[button]";
      break;
    }
    case "system": {
      // WhatsApp Cloud API: eventos de plataforma (ex.: cliente mudou de número).
      // Ref: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/system
      const sys = obj(message.system);
      const body = str(sys.body);
      const sysType = str(sys.type);
      if (body) {
        text = body;
      } else if (sysType) {
        text = `[Sistema WhatsApp: ${sysType}]`;
      } else {
        text = "[Evento do sistema WhatsApp]";
      }
      break;
    }
    case "unsupported": {
      // Meta Cloud API: tipo que a API não consegue entregar o conteúdo.
      // Ref: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported/
      // Causas comuns (131051): álbum multi-imagem, enquete, edição, GIF,
      // convite de grupo. Em álbuns a Meta costuma mandar 1× unsupported e
      // em seguida as imagens individuais — o conteúdo do álbum em si não
      // vem. 131060 = mensagem indisponível (1º contato em nº do app WA Business).
      text = labelUnsupportedMessage(message);
      break;
    }
    default:
      text = `[${type}]`;
  }

  const referral = parseReferral(message);

  // Contexto de resposta: quando o cliente responde uma mensagem específica,
  // a Meta envia `context.id` = wamid da mensagem citada. Ignoramos o resto
  // do contexto (from, forwarded, referred_product) por enquanto — só
  // usamos o id para linkar via replyToId no Message local.
  const context = obj(message.context);
  const replyToWaMessageId = str(context.id) || null;

  return {
    waMessageId: id,
    timestamp,
    type,
    text,
    mediaUrl,
    mediaId,
    mimeType,
    replyToWaMessageId,
    reactionTarget: null,
    interactiveButtonId,
    interactiveButtonTitle,
    interactiveKind,
    callPermissionType,
    referral,
    flowPayload,
    flowMetaName,
    flowToken,
  };
}

// ── Download media from Meta & save locally ──────

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "audio/ogg": "ogg", "audio/ogg; codecs=opus": "ogg", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "audio/amr": "amr", "audio/aac": "aac",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "application/vnd.ms-powerpoint": "ppt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function mimeToExt(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? base.split("/").pop()?.replace(/[^a-z0-9]/g, "") ?? "bin";
}

async function resolveAccessToken(phoneNumberId?: string): Promise<string | null> {
  if (phoneNumberId) {
    const ch = await findChannelByPhoneNumberId(phoneNumberId);
    if (ch) {
      const cfg = ch.config as Record<string, unknown> | null;
      const raw = typeof cfg?.accessToken === "string" ? cfg.accessToken.trim() : "";
      if (raw) {
        try {
          const token = decryptSecret(raw).trim();
          if (token) return token;
        } catch (err) {
          log.error(
            `Falha ao decifrar accessToken do canal ${ch.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }
  return process.env.META_WHATSAPP_ACCESS_TOKEN?.trim() ?? null;
}

async function downloadAndSaveMedia(
  mediaId: string,
  mimeType: string | null,
  organizationId: string,
  phoneNumberId?: string,
): Promise<string | null> {
  const token = await resolveAccessToken(phoneNumberId);
  if (!token || !mediaId) return null;

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
    );
    if (!metaRes.ok) {
      log.warn(`Falha ao obter URL da mídia ${mediaId}: HTTP ${metaRes.status}`);
      return null;
    }
    const urlData = (await metaRes.json()) as { url?: string };
    const downloadUrl = urlData.url;
    if (!downloadUrl) return null;

    const fileRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!fileRes.ok) {
      log.warn(`Falha ao baixar mídia ${mediaId}: HTTP ${fileRes.status}`);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    const ext = mimeToExt(mimeType || "application/octet-stream");
    const fileName = generateFileName({ prefix: "in", ext });
    // PR 1.3: storage por org. Antes: `public/uploads/<file>` shared.
    const saved = await saveFile({
      orgId: organizationId,
      bucket: "inbound-media",
      fileName,
      buffer,
    });

    log.debug(
      `Mídia ${mediaId} salva (${(buffer.length / 1024).toFixed(1)} KB) em ${saved.url}`,
    );
    return saved.url;
  } catch (err) {
    log.error("Erro ao baixar mídia da Meta:", err);
    return null;
  }
}

// ── Status updates ───────────────────────────────

const VALID_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function findStatusMessage(wamid: string) {
  return prisma.message.findFirst({
    where: { externalId: wamid },
    select: {
      id: true,
      sendStatus: true,
      conversationId: true,
      organizationId: true,
      externalId: true,
      content: true,
    },
  });
}

type StatusMessageRow = NonNullable<Awaited<ReturnType<typeof findStatusMessage>>>;
type CampaignRecipientRow = { id: string; status: string; campaignId: string };

/**
 * Resolução em lote dos `wamid` de um mesmo `change` do webhook. Um blast
 * de campanha chega com dezenas de statuses por payload e cada um fazia
 * dois `findFirst` (message + campaign_recipient) antes dos updates. Aqui
 * as duas leituras viram um `in` só e o laço trabalha em memória.
 *
 * As entradas são MUTÁVEIS de propósito: quando o mesmo wamid aparece duas
 * vezes no payload (sent seguido de delivered), o segundo passo precisa
 * enxergar o `sendStatus`/`status` já gravado pelo primeiro, exatamente
 * como acontecia quando cada iteração relia do banco.
 */
type StatusBatchCache = {
  messages: Map<string, StatusMessageRow>;
  recipients: Map<string, CampaignRecipientRow>;
};

async function prefetchStatusBatch(
  statuses: unknown[],
): Promise<StatusBatchCache | undefined> {
  const wamids = Array.from(
    new Set(
      statuses
        .map((s) => str(obj(s).id))
        .filter((id) => id.length > 0),
    ),
  );
  // Com 0 ou 1 wamid o lote não economiza nada — mantém o caminho antigo.
  if (wamids.length < 2) return undefined;

  try {
    const [messages, recipients] = await Promise.all([
      prisma.message.findMany({
        where: { externalId: { in: wamids } },
        select: {
          id: true,
          sendStatus: true,
          conversationId: true,
          organizationId: true,
          externalId: true,
          content: true,
        },
      }),
      prisma.campaignRecipient.findMany({
        where: { metaMessageId: { in: wamids } },
        select: { id: true, status: true, campaignId: true, metaMessageId: true },
      }),
    ]);

    const cache: StatusBatchCache = { messages: new Map(), recipients: new Map() };
    for (const m of messages) {
      // Mesma escolha do `findFirst`: a primeira linha vista vence.
      if (m.externalId && !cache.messages.has(m.externalId)) {
        cache.messages.set(m.externalId, m);
      }
    }
    for (const r of recipients) {
      if (r.metaMessageId && !cache.recipients.has(r.metaMessageId)) {
        cache.recipients.set(r.metaMessageId, {
          id: r.id,
          status: r.status,
          campaignId: r.campaignId,
        });
      }
    }
    return cache;
  } catch (err) {
    // Falha na pré-carga não pode derrubar o webhook: sem cache, cada
    // status volta a resolver sozinho.
    log.warn("Erro na pré-carga em lote dos statuses:", err);
    return undefined;
  }
}

async function processStatusUpdate(
  status: Record<string, unknown>,
  cache?: StatusBatchCache,
) {
  const wamid = str(status.id);
  const s = str(status.status);
  if (!wamid || !s) return;

  if (!VALID_STATUSES.has(s)) {
    log.debug(`Status ignorado ${wamid} → ${s}`);
    return;
  }

  try {
    const msg = cache
      ? cache.messages.get(wamid) ?? null
      : await findStatusMessage(wamid);
    if (!msg) {
      // Status chegou antes do externalId ser gravado (race raro) ou
      // wamid desconhecido — sem mensagem não há o que atualizar na UI.
      log.info(`Status ${s} ignorado: mensagem externalId=${wamid} não encontrada`);
      await updateCampaignRecipientStatus(wamid, s, status, cache);
      return;
    }

    // Progressão normal: pending(0) → sent(1) → delivered(2) → read(3).
    // "failed" NÃO entra nessa escala — é um estado terminal que
    // SEMPRE deve sobrepor, porque a Meta pode mandar `sent` no ACK
    // inicial e minutos depois `failed` (cliente bloqueou, janela de
    // 24h expirou na entrega, número inválido, etc). Antes o código
    // tratava failed como prioridade 0 e descartava esse callback,
    // deixando a UI eternamente com ✓ mesmo após a falha real.
    const statusPriority: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
    // Normaliza caso (outros caminhos podem gravar SENT/DELIVERED/READ).
    const currentPriority =
      statusPriority[(msg.sendStatus ?? "").toLowerCase()] ?? 0;
    const newPriority = statusPriority[s] ?? 0;

    const isFailure = s === "failed";
    const shouldUpdate = isFailure
      ? (msg.sendStatus ?? "").toLowerCase() !== "failed"
      : newPriority > currentPriority;

    // Sempre sincroniza CampaignRecipient (contadores delivered/read), mesmo
    // quando o Message já está no mesmo status — e usa o retorno para
    // silenciar SSE/activity em blast.
    const isCampaignMsg = await updateCampaignRecipientStatus(wamid, s, status, cache);

    if (shouldUpdate) {
        // Estrutura oficial do erro do webhook (Meta docs):
        //   errors[i] = { code, title, message, error_data: { details }, href }
        // Recomendação Meta: usar `code` como chave de lógica, `error_data.details`
        // como texto mais acionável (ex.: "Message failed to send because more than
        // 24 hours have passed since the customer last replied to this number"),
        // e `href` como link oficial pra diagnosticar. `title` pode ser deprecado.
        const errorInfo = isFailure
          ? (() => {
              const errors = arr(status.errors);
              if (errors.length === 0) return null;
              const e = obj(errors[0]);
              const code = typeof e.code === "number" ? e.code : null;
              const title = str(e.title);
              const message = str(e.message);
              const details = str(obj(e.error_data).details);
              const href = str(e.href);
              // Prioriza details (texto acionável) > message > title.
              const rawHuman = details || message || title || "Falha no envio";
              // Traduz para PT-BR pelo `code` catalogado (mesma convenção do
              // envio imediato em MetaGraphError.toPersistedString): mostra o
              // motivo em português e mantém o texto original da Meta entre
              // parênteses para diagnóstico.
              const ptReason = metaErrorReason(code);
              const human = ptReason ? `${ptReason} (Meta: ${rawHuman})` : rawHuman;
              const metaParts: string[] = [];
              if (code != null) metaParts.push(`code ${code}`);
              return {
                text:
                  metaParts.length > 0
                    ? `${human} (${metaParts.join(", ")})`
                    : human,
                code,
                title,
                details,
                href,
              };
            })()
          : null;

        const sendError = errorInfo?.text ?? (isFailure ? "Falha no envio" : null);

        // `wasFailed` é lido depois do update; guarda o valor de antes.
        const previousSendStatus = msg.sendStatus;

        // Kill switch: STATUS_WRITE_BUFFER_ENABLED=0 volta ao update individual
        // (caminho histórico). Default ligado — escrita em lote com guarda de
        // prioridade no WHERE (ver src/lib/status-write-buffer.ts).
        // sendError: undefined = não tocar, null = limpar, string = gravar.
        if (isStatusWriteBufferEnabled()) {
          bufferMessageStatus({
            id: msg.id,
            sendStatus: s,
            sendError: isFailure
              ? sendError
              : s === "delivered" || s === "read"
                ? null
                : undefined,
          });
        } else {
          await prisma.message.update({
            where: { id: msg.id },
            data: {
              sendStatus: s,
              ...(isFailure
                ? { sendError }
                : // Entrega/leitura posteriores limpam erro stale (ex.: sweeper
                  // marcou timeout e a Meta confirmou delivered depois).
                  s === "delivered" || s === "read"
                  ? { sendError: null }
                  : {}),
            },
          });
        }

        // Mantém a linha em cache coerente com o banco para o caso de o
        // mesmo wamid aparecer de novo no mesmo payload.
        msg.sendStatus = s;

        if (isFailure) {
          // Erros de elegibilidade (fora da janela 24h, conta inexistente,
          // marketing limitado) não são acionáveis na conversa — não levam
          // o ticket para a fila Erro. A mensagem segue `failed` na thread.
          if (!isMetaNonConversationErrorCode(errorInfo?.code)) {
            const { markConversationHasError } = await import(
              "@/services/conversation-error-flag"
            );
            await markConversationHasError(msg.conversationId);
          }
          log.warn(
            `Mensagem ${wamid} falhou no envio: code=${errorInfo?.code ?? "?"} title="${errorInfo?.title ?? ""}" details="${errorInfo?.details ?? ""}" href=${errorInfo?.href ?? "-"}`,
          );
          // Falha reportada pela Meta é sinal forte de problema no
          // número (quality rating, limite, flag). Força refresh do
          // healthcheck pra banner aparecer rápido no dashboard.
          try {
            const { refreshWhatsAppHealth } = await import(
              "@/services/whatsapp-health"
            );
            refreshWhatsAppHealth();
          } catch {
            // best-effort
          }

          // Activity Log: registra a falha no feed unificado (/logs) e nas
          // estatisticas. Fire-and-forget — nao bloqueia o webhook.
          void (async () => {
            const conv = await prisma.conversation
              .findUnique({
                where: { id: msg.conversationId },
                select: {
                  contactId: true,
                  contact: { select: { name: true, phone: true } },
                },
              })
              .catch(() => null);
            const openDeal = conv?.contactId
              ? await prisma.deal
                  .findFirst({
                    where: { contactId: conv.contactId, status: "OPEN" },
                    select: { id: true },
                    orderBy: { updatedAt: "desc" },
                  })
                  .catch(() => null)
              : null;
            await logMessageFailed({
              messageId: msg.id,
              conversationId: msg.conversationId,
              contactId: conv?.contactId ?? null,
              dealId: openDeal?.id ?? null,
              contactLabel: conv?.contact?.name ?? null,
              contactSublabel: conv?.contact?.phone ?? null,
              error: sendError,
              source: "meta",
              errorCode: errorInfo?.code ?? null,
              channel: "WhatsApp",
            });
          })();
        } else if (s === "delivered" || s === "read") {
          // Se não sobrou mensagem failed nesta conversa, tira da fila Erro
          // (caso clássico: sweeper marcou timeout e a Meta entregou depois).
          // Só vale rodar o count quando ESTA mensagem estava failed — em
          // blast (sent→delivered/read sem falha prévia) o count por status
          // gerava ~4-6k queries inúteis no PG compartilhado.
          const wasFailed = (previousSendStatus ?? "").toLowerCase() === "failed";
          if (wasFailed) {
            const stillFailed = await prisma.message
              .count({
                where: {
                  conversationId: msg.conversationId,
                  sendStatus: "failed",
                },
              })
              .catch(() => 1);
            if (stillFailed === 0) {
              await prisma.conversation
                .update({
                  where: { id: msg.conversationId },
                  data: { hasError: false },
                })
                .catch(() => {});
            }
          } else {
            // Regra de produto (ago/26): QUALQUER envio que a Meta confirma
            // como entregue/lido depois de um erro tira a conversa da fila
            // Erro — o problema foi resolvido (ex.: pagamento regularizado
            // e reenvio entregue). Antes o count exigia zero `failed` na
            // conversa, o que prendia tickets com falha ANTIGA já superada.
            // Sem o count: um único UPDATE por delivered/read só roda quando
            // a conversa está marcada, então o custo é ~zero no caminho feliz.
            await prisma.conversation
              .updateMany({
                where: { id: msg.conversationId, hasError: true },
                data: { hasError: false },
              })
              .catch(() => {});
          }
        }

        // O GET /messages expõe id = externalId ?? id (id da bolha no
        // front). Se publicarmos só o UUID interno, o update otimista
        // nunca casa e os ticks só mudam no refetch/poll.
        const bubbleId = msg.externalId ?? msg.id;
        const orgId = getOrgIdOrNull() ?? msg.organizationId;

        // Campanha: NÃO faz fan-out SSE nem activity-log de leitura.
        // Em blast (~2k) cada wamid gera 2–4 statuses → stampede de
        // invalidate inbox em todos os operadores.
        if (!isCampaignMsg) {
          try {
            sseBus.publish("message_status", {
              organizationId: orgId,
              conversationId: msg.conversationId,
              messageId: bubbleId,
              internalId: msg.id,
              status: s,
              ...(isFailure && sendError ? { error: sendError } : {}),
            });
          } catch {}
        }

        if (s === "read" && !isCampaignMsg) {
          log.info(
            `Mensagem lida wamid=${wamid} conversationId=${msg.conversationId} bubbleId=${bubbleId}`,
          );
          // Activity Log + timeline do deal — base para estatística de leitura.
          void (async () => {
            const conv = await prisma.conversation
              .findUnique({
                where: { id: msg.conversationId },
                select: {
                  contactId: true,
                  contact: { select: { name: true, phone: true } },
                },
              })
              .catch(() => null);
            let dealId: string | null = null;
            if (conv?.contactId) {
              const open = await prisma.deal
                .findFirst({
                  where: { contactId: conv.contactId, status: "OPEN" },
                  select: { id: true },
                  orderBy: { updatedAt: "desc" },
                })
                .catch(() => null);
              if (open) {
                dealId = open.id;
              } else {
                const any = await prisma.deal
                  .findFirst({
                    where: { contactId: conv.contactId },
                    select: { id: true },
                    orderBy: { updatedAt: "desc" },
                  })
                  .catch(() => null);
                dealId = any?.id ?? null;
              }
            }
            await logMessageRead({
              messageId: msg.id,
              conversationId: msg.conversationId,
              contactId: conv?.contactId ?? null,
              dealId,
              contactLabel: conv?.contact?.name ?? null,
              contactSublabel: conv?.contact?.phone ?? null,
              preview: msg.content?.slice(0, 200) ?? null,
              source: "meta",
              channel: "WhatsApp",
            });
          })();
        }
    }

    log.debug(`Status ${wamid} → ${s}`);
  } catch (err) {
    log.warn("Erro ao atualizar status da mensagem:", err);
  }
}

/** @returns true se o wamid pertence a um destinatário de campanha. */
async function updateCampaignRecipientStatus(
  metaMessageId: string,
  status: string,
  raw: Record<string, unknown>,
  cache?: StatusBatchCache,
): Promise<boolean> {
  try {
    const recipient = cache
      ? cache.recipients.get(metaMessageId) ?? null
      : await prisma.campaignRecipient.findFirst({
          where: { metaMessageId },
          select: { id: true, status: true, campaignId: true },
        });
    if (!recipient) return false;

    const statusMap: Record<string, string> = {
      sent: "SENT",
      delivered: "DELIVERED",
      read: "READ",
      failed: "FAILED",
    };
    const newStatus = statusMap[status];
    if (!newStatus) return true;

    const priority: Record<string, number> = { PENDING: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 0 };
    if ((priority[newStatus] ?? 0) <= (priority[recipient.status] ?? 0) && newStatus !== "FAILED") {
      return true;
    }

    const data: Record<string, unknown> = { status: newStatus };
    if (status === "delivered") data.deliveredAt = new Date();
    if (status === "read") data.readAt = new Date();
    if (status === "failed") {
      const errors = arr(raw.errors);
      const e = errors.length > 0 ? obj(errors[0]) : {};
      const details = str(obj(e.error_data).details);
      const code = typeof e.code === "number" ? e.code : null;
      const human =
        details || str(e.message) || str(e.title) || "Falha no envio";
      const catalog = code != null ? metaErrorReason(code) : "";
      data.errorMessage = catalog
        ? `${catalog} (Meta: ${human}) (code ${code})`
        : code != null
          ? `${human} (code ${code})`
          : human;
    }

    // Kill switch: STATUS_WRITE_BUFFER_ENABLED=0 volta ao update individual.
    // Default ligado — escrita em lote com guarda de prioridade no WHERE do
    // UPDATE (ver src/lib/status-write-buffer.ts). A guarda em memória acima
    // (:1850) vira otimização; a de verdade está no SQL.
    if (isStatusWriteBufferEnabled()) {
      bufferRecipientStatus({
        id: recipient.id,
        status: newStatus,
        data: {
          deliveredAt: data.deliveredAt as Date | undefined,
          readAt: data.readAt as Date | undefined,
          errorMessage: data.errorMessage as string | null | undefined,
        },
      });
    } else {
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data,
      });
    }

    const counterField: CampaignCounterField | null =
      status === "delivered"
        ? "deliveredCount"
        : status === "read"
          ? "readCount"
          : status === "failed" && recipient.status !== "FAILED"
            ? "failedCount"
            : null;

    if (counterField) {
      // Bufferizado (flush em lote ~2s/50) — em blast, 1 UPDATE por status
      // na mesma row da Campaign gerava lock contention no PG compartilhado.
      incrementCampaignCounter(recipient.campaignId, counterField);
    }

    // Depois de `counterField`, que compara com o status ANTERIOR: mantém
    // o cache coerente para um segundo status do mesmo wamid no payload.
    recipient.status = newStatus;
    return true;
  } catch (err) {
    log.warn("Erro ao atualizar destinatário da campanha:", err);
    return false;
  }
}

// ── GET: Webhook verification ────────────────────

function timingSafeStringEqual(a: string, b: string): boolean {
  // Compara strings em tempo constante para o tamanho da menor delas;
  // evita timing attack vazando o tamanho/conteúdo do verify token.
  if (a.length === 0 || b.length === 0) return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const META_WEBHOOK_CHANNEL_OR = [
  { type: "WHATSAPP" as const, provider: "META_CLOUD_API" as const },
  { type: "INSTAGRAM" as const, provider: "META_INSTAGRAM_LOGIN" as const },
  { type: "INSTAGRAM" as const, provider: "META_CLOUD_API" as const },
  { type: "FACEBOOK" as const, provider: "META_CLOUD_API" as const },
];

export async function handleMetaWebhookGet(
  request: Request,
  scope?: WebhookScope,
): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (scope) {
    // Multi-tenant: valida contra Channel.config.verifyToken DESSA org.
    // Usa prismaBase pra rodar cross-org sem precisar abrir context (so
    // estamos lendo o config do channel pra autenticar o handshake da Meta).
    const channels = await prismaBase.channel.findMany({
      where: {
        organizationId: scope.organizationId,
        OR: META_WEBHOOK_CHANNEL_OR,
      },
      select: { id: true, name: true, config: true },
    });
    // PR-1.2: verifyToken pode estar encriptado (enc:v1:...) ou plaintext
    // (canais antigos pre-backfill). Decripta defensivamente em ambos os casos.
    const tokens = channels
      .map((c) => {
        const cfg = c.config as Record<string, unknown> | null;
        const raw = typeof cfg?.verifyToken === "string" ? cfg.verifyToken.trim() : "";
        if (!raw) return "";
        if (!isEncryptedSecret(raw)) return raw;
        try {
          return decryptSecret(raw);
        } catch (err) {
          log.error(
            `Falha ao decriptar verifyToken do canal ${c.id}: ${err instanceof Error ? err.message : err}`,
          );
          return "";
        }
      })
      .filter((t) => t.length > 0);

    // Fallback: canais provisionados via App Meta global do CRM (conexao
    // manual token-based / embedded signup) NAO gravam verifyToken proprio —
    // o handshake da Meta usa o META_WEBHOOK_VERIFY_TOKEN global do env,
    // configurado uma unica vez no painel do App Meta do CRM. Aceitamos
    // tanto per-channel (canais legacy Opcao B) quanto o global.
    if (VERIFY_TOKEN) tokens.push(VERIFY_TOKEN);

    if (tokens.length === 0) {
      log.error(
        `org="${scope.organizationSlug}" sem verifyToken cadastrado em nenhum canal Meta e sem META_WEBHOOK_VERIFY_TOKEN global — recusando verificacao`,
      );
      return NextResponse.json(
        { error: "verifyToken not configured" },
        { status: 503 },
      );
    }

    if (
      mode === "subscribe" &&
      token &&
      tokens.some((t) => timingSafeStringEqual(token, t))
    ) {
      log.info(`Verificacao do webhook Meta: OK (org=${scope.organizationSlug})`);
      return new Response(challenge ?? "", { status: 200 });
    }

    log.warn(
      `Verificacao FAIL (org=${scope.organizationSlug}, mode=${mode}, token len=${token?.length ?? 0})`,
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Legacy (sem slug): aceita VERIFY_TOKEN global (env) OU qualquer
  // Channel.config.verifyToken de qualquer canal Meta (any-match).
  // Fluxo novo: /api/channels/manual-cloud grava verifyToken per-channel
  // e o cliente configura no painel Meta a URL slugless — este ramo
  // valida contra todos os canais (mesma logica do collectAppSecrets).
  const legacyTokens: string[] = [];
  if (VERIFY_TOKEN) legacyTokens.push(VERIFY_TOKEN);
  try {
    const channels = await prismaBase.channel.findMany({
      where: { OR: META_WEBHOOK_CHANNEL_OR },
      select: { id: true, config: true },
    });
    for (const c of channels) {
      const cfg = c.config as Record<string, unknown> | null;
      const raw = typeof cfg?.verifyToken === "string" ? cfg.verifyToken.trim() : "";
      if (!raw) continue;
      let secret = raw;
      if (isEncryptedSecret(raw)) {
        try {
          secret = decryptSecret(raw);
        } catch (err) {
          log.error(
            `Falha ao decriptar verifyToken do canal ${c.id}: ${err instanceof Error ? err.message : err}`,
          );
          continue;
        }
      }
      if (secret) legacyTokens.push(secret);
    }
  } catch (e) {
    log.warn("Erro ao buscar verifyTokens dos canais (legacy GET):", e);
  }

  if (legacyTokens.length === 0) {
    log.error("Nenhum verifyToken configurado (env META_WEBHOOK_VERIFY_TOKEN nem Channel.config.verifyToken) — verificacao desabilitada");
    return NextResponse.json(
      { error: "Webhook verification not configured" },
      { status: 503 },
    );
  }

  if (mode === "subscribe" && token && legacyTokens.some((t) => timingSafeStringEqual(token, t))) {
    log.info(`Verificação do webhook Meta: OK (legacy, ${legacyTokens.length} token(s) testado(s))`);
    return new Response(challenge ?? "", { status: 200 });
  }

  log.warn("Verificação do webhook Meta falhou:", { mode, token: token?.slice(0, 6), triedTokens: legacyTokens.length });
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// ── POST: Receive messages ───────────────────────

/** TTL do cache de lookups de canal do webhook (phoneNumberId→org e
 * appSecrets). 60s: janela curta de staleness; a invalidação explícita em
 * `services/channels.ts` (delPattern "meta_wh:*") cobre edições de canal. */
const META_WH_CACHE_TTL_SEC = 60;

async function collectAppSecrets(scope?: WebhookScope): Promise<string[]> {
  const secrets = new Set<string>();

  // Inclui SEMPRE o CRM_META_APP_SECRET global — desde a introducao da
  // conexao manual token-based (App Meta global do CRM, igual Datacrazy),
  // canais podem ser assinados via subscribed_apps ao app do CRM e portanto
  // suas mensagens chegam assinadas com o secret global. Canais legacy
  // (com App Secret proprio no config) continuam sendo aceitos pelo
  // collector abaixo — o verifier testa multiplos secrets ate encontrar um
  // que valide (any-match).
  if (CRM_META_APP_SECRET) secrets.add(CRM_META_APP_SECRET);
  const igSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
  if (igSecret) secrets.add(igSecret);

  // Cache-aside 60s: este findMany rodava 1× por POST de webhook (28,6k
  // calls na janela do stress sa221601). O loader NÃO captura erro de DB —
  // throw dentro do wrap não grava cache, então um blip transitório não
  // fica cacheado como lista degradada; o catch aqui preserva o fallback
  // histórico (só secrets de env).
  try {
    const channelSecrets = await cache.wrap(
      `meta_wh:secrets:${scope?.organizationId ?? "global"}`,
      META_WH_CACHE_TTL_SEC,
      () => loadChannelAppSecrets(scope),
    );
    for (const s of channelSecrets) secrets.add(s);
  } catch (e) {
    log.warn("Erro ao buscar appSecrets dos canais:", e);
  }
  return [...secrets];
}

async function loadChannelAppSecrets(scope?: WebhookScope): Promise<string[]> {
  // Usa prismaBase sempre: no path scoped filtramos por organizationId
  // explicitamente; no path legacy (sem slug — agora padrao oficial da
  // conexao manual token-based) buscamos cross-org e o handler routeia
  // pelo phone_number_id do payload. prismaBase evita a exigencia de
  // RequestContext ativo da Prisma extension.
  const where = scope
    ? {
        organizationId: scope.organizationId,
        OR: META_WEBHOOK_CHANNEL_OR,
      }
    : { OR: META_WEBHOOK_CHANNEL_OR };
  const channels = await prismaBase.channel.findMany({
    where,
    select: { config: true },
  });
  const secrets = new Set<string>();
  for (const ch of channels) {
    const cfg = ch.config as Record<string, unknown> | null;
    const raw = typeof cfg?.appSecret === "string" ? cfg.appSecret.trim() : "";
    if (!raw) continue;
    // PR-1.2: appSecret pode estar encriptado ou plaintext (back-compat).
    let secret = raw;
    if (isEncryptedSecret(raw)) {
      try {
        secret = decryptSecret(raw);
      } catch (err) {
        log.error(
          `Falha ao decriptar appSecret de canal Meta: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
    }
    if (secret) secrets.add(secret);
  }
  return [...secrets];
}

export async function handleMetaWebhookPost(
  request: Request,
  scope?: WebhookScope,
): Promise<Response> {
  // Quando ha scope explicito na URL (/api/webhooks/meta/<slug>), usa direto.
  if (scope) {
    return withSystemContext(scope.organizationId, () =>
      executePostBody(request, scope),
    );
  }

  // Path slugless (padrao oficial da conexao manual token-based): tem que
  // resolver a org DO PAYLOAD (phone_number_id -> Channel.organizationId)
  // ANTES de executar, pra que todas as queries scoped downstream tenham
  // RequestContext. Consumimos o body aqui e reconstruimos a Request pro
  // executor poder re-ler rawBody pra validacao de assinatura.
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch (err) {
    log.error("Erro ao ler body do webhook Meta:", err);
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  let inferredScope: WebhookScope | undefined;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const phoneNumberId = extractFirstPhoneNumberId(parsed);
    if (phoneNumberId) {
      // Cache-aside 60s do mapeamento phoneNumberId → org/canal: este
      // findFirst rodava 1× por POST (somado ao findMany de appSecrets,
      // eram 2 lookups de channel por webhook — stress sa221601).
      // Invalidado na edição de canal (delPattern "meta_wh:*").
      const channel = await cache.wrap(
        `meta_wh:phone:${phoneNumberId}`,
        META_WH_CACHE_TTL_SEC,
        async () => {
          const ch = await prismaBase.channel.findFirst({
            where: {
              type: "WHATSAPP",
              provider: "META_CLOUD_API",
              config: { path: ["phoneNumberId"], equals: phoneNumberId },
            },
            select: { organizationId: true, organization: { select: { slug: true } } },
          });
          return ch
            ? {
                organizationId: ch.organizationId,
                organizationSlug: ch.organization?.slug ?? "",
              }
            : null;
        },
      );
      if (channel) {
        inferredScope = {
          organizationId: channel.organizationId,
          organizationSlug: channel.organizationSlug,
        };
      } else {
        log.debug(
          `Legacy POST: phone_number_id=${phoneNumberId} nao mapeado a nenhum canal — ignorando`,
        );
      }
    } else {
      const messagingEntryId = extractFirstMessagingEntryId(parsed);
      if (messagingEntryId) {
        const channel = await findMessagingChannelForEntryId(messagingEntryId);
        if (channel) {
          inferredScope = {
            organizationId: channel.organizationId,
            organizationSlug: channel.organizationSlug,
          };
        } else {
          log.debug(
            `Legacy POST: entry.id=${messagingEntryId} nao mapeado a canal Instagram/Messenger`,
          );
        }
      }
    }
  } catch (err) {
    log.warn("Legacy POST: falha ao parsear body pra inferir org:", err);
  }

  // Rebuild a request equivalent que o executor consegue re-ler.
  const rebuilt = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  });

  if (inferredScope) {
    return withSystemContext(inferredScope.organizationId, () =>
      executePostBody(rebuilt, inferredScope),
    );
  }

  // Sem canal correspondente ao phone_number_id do payload: nao ha
  // como resolver a org, entao NAO tentamos validar assinatura contra
  // segredos agregados de todas as orgs (isso permitiria a um atacante
  // que obteve o appSecret de uma org forjar payloads "de outra org"
  // usando um phone_number_id desconhecido). Aceitamos apenas se a
  // assinatura casar com o CRM_META_APP_SECRET global (App do CRM) —
  // caso legitimo de canal ainda nao onboarded / desprovisionado.
  const sig = rebuilt.headers.get("x-hub-signature-256");
  if (CRM_META_APP_SECRET && sig && verifyMetaWebhookSignature(bodyText, sig, CRM_META_APP_SECRET)) {
    log.debug(
      "Legacy POST sem org resolvida — assinatura casou com CRM_META_APP_SECRET; auditando sem processar.",
    );
    return NextResponse.json({ status: "ignored_unmapped_channel" });
  }
  log.warn(
    "Legacy POST sem canal correspondente ao phone_number_id — recusando (nao processavel sem org).",
  );
  return NextResponse.json({ status: "ignored_unmapped_channel" }, { status: 200 });
}

function extractFirstPhoneNumberId(body: Record<string, unknown>): string | null {
  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const changes = Array.isArray(e.changes) ? e.changes : [];
    for (const change of changes) {
      const ch = (change ?? {}) as Record<string, unknown>;
      const value = (ch.value ?? {}) as Record<string, unknown>;
      const metadata = (value.metadata ?? {}) as Record<string, unknown>;
      const pid = typeof metadata.phone_number_id === "string"
        ? metadata.phone_number_id.trim()
        : "";
      if (pid) return pid;
    }
  }
  return null;
}

function extractFirstMessagingEntryId(body: Record<string, unknown>): string | null {
  const object = typeof body.object === "string" ? body.object : "";
  if (object !== "instagram" && object !== "page") return null;
  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    const id = asMetaId((entry as { id?: unknown } | null)?.id);
    if (id) return id;
  }
  return null;
}

async function findMessagingChannelForEntryId(
  entryId: string,
): Promise<{ organizationId: string; organizationSlug: string } | null> {
  const paths = ["instagramUserId", "instagramAccountId", "pageId"] as const;
  for (const path of paths) {
    const channel = await prismaBase.channel.findFirst({
      where: {
        OR: [{ type: "INSTAGRAM" }, { type: "FACEBOOK" }],
        config: { path: [path], equals: entryId },
      },
      select: {
        organizationId: true,
        organization: { select: { slug: true } },
      },
    });
    if (channel) {
      return {
        organizationId: channel.organizationId,
        organizationSlug: channel.organization?.slug ?? "",
      };
    }
  }

  const fallback = await prismaBase.channel.findMany({
    where: { OR: [{ type: "INSTAGRAM" }, { type: "FACEBOOK" }] },
    select: {
      organizationId: true,
      config: true,
      organization: { select: { slug: true } },
    },
  });
  const matched = fallback.filter((row) => configMetaIds(row.config).has(entryId));
  if (matched.length !== 1) return null;
  return {
    organizationId: matched[0].organizationId,
    organizationSlug: matched[0].organization?.slug ?? "",
  };
}

async function executePostBody(
  request: Request,
  scope: WebhookScope | undefined,
): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  log.debug(`POST recebido (${rawBody.length} bytes, assinatura=${signature ? "sim" : "não"}, scope=${scope?.organizationSlug ?? "(legacy)"})`);

  const secrets = await collectAppSecrets(scope);
  let signatureValid = false;
  if (secrets.length > 0) {
    signatureValid = secrets.some((s) =>
      verifyMetaWebhookSignature(rawBody, signature, s),
    );
    if (!signatureValid) {
      log.warn(
        `Assinatura inválida (${secrets.length} secret(s) testado(s)) — verifique CRM_META_APP_SECRET / channel.config.appSecret`,
      );
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (REQUIRE_SIGNATURE) {
    // Em produção, NUNCA aceitar webhook sem App Secret configurado —
    // qualquer um na internet pode forjar payload "do Meta" e injetar
    // mensagens fake, criar contatos, disparar automações etc.
    log.error("PROD sem App Secret — recusando POST (configure META_APP_SECRET ou channel.config.appSecret)");
    return NextResponse.json(
      { error: "Webhook signature verification not configured" },
      { status: 503 },
    );
  } else {
    log.debug("Nenhum App Secret configurado — assinatura não verificada (dev/preview)");
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Auditoria: persistir TODOS os POSTs Meta com payload bruto integral.
  // Linkamos depois com automation_logs via context.data.metaWebhookEventId
  // para exibir o JSON original do webhook na UI da automação.
  const metaWebhookEventId = await createMetaWebhookEvent({
    rawBody: body,
    headers: pickWebhookHeaders(request.headers),
    signatureValid,
    scope,
  });

  const object = str(body.object);
  if (object === "page" || object === "instagram") {
    // Callback do produto Instagram/Messenger colada por engano na URL
    // do WhatsApp (/api/webhooks/meta). Encaminha em vez de ignorar.
    return handleMessagingWebhookPost(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: rawBody,
      }),
      { skipSignature: true },
    );
  }
  if (object !== "whatsapp_business_account") {
    if (metaWebhookEventId) {
      await markWebhookEventProcessed(metaWebhookEventId, "object_ignored");
    }
    return NextResponse.json({ status: "ignored" });
  }

  // Chamadas WebRTC: o SDP answer tem de chegar ao browser em segundos.
  // Não esperar o worker-meta-webhook (fila Redis).
  if (webhookPayloadHasCallsField(body)) {
    return processMetaWebhookPayload(body, { metaWebhookEventId });
  }

  // Offload: API só audita + enfileira; o worker-meta-webhook executa o
  // loop pesado. Sem isso, status de campanha (2-4 por mensagem) processam
  // síncrono no processo do inbox e derrubam GET /api/conversations.
  if (META_WEBHOOK_ASYNC && metaWebhookEventId) {
    const organizationId =
      scope?.organizationId ??
      (await prismaBase.metaWebhookEvent
        .findUnique({ where: { id: metaWebhookEventId }, select: { organizationId: true } })
        .then((e) => e?.organizationId ?? null)
        .catch(() => null));
    if (organizationId) {
      const queued = await enqueueMetaWebhookEvent({
        metaWebhookEventId,
        organizationId,
      }).catch(() => null);
      if (queued) {
        return NextResponse.json({ status: "accepted" });
      }
      // Sem fail-open sync: não processar no processo da API. Meta reintenta.
      log.warn(
        "enqueue meta-webhook falhou (Redis?) — 503 para retry da Meta (sem sync na API)",
      );
      return NextResponse.json(
        { status: "unavailable", message: "Fila Meta indisponível" },
        { status: 503 },
      );
    }
    log.warn(
      "MetaWebhookEvent sem organizationId — 503 para retry (sem sync na API)",
    );
    return NextResponse.json(
      { status: "unavailable", message: "Evento Meta sem organização" },
      { status: 503 },
    );
  }

  return processMetaWebhookPayload(body, { metaWebhookEventId });
}

/**
 * Loop de processamento do payload Meta (statuses + mensagens + calls).
 * Extraído de `executePostBody` para reuso pelo `worker-meta-webhook`.
 * Deve rodar dentro de `withSystemContext(organizationId)`.
 */
function webhookPayloadHasCallsField(body: Record<string, unknown>): boolean {
  for (const entry of arr(body.entry)) {
    for (const change of arr(obj(entry).changes)) {
      if (str(obj(change).field) === "calls") return true;
    }
  }
  return false;
}

export async function processMetaWebhookPayload(
  body: Record<string, unknown>,
  opts: { metaWebhookEventId: string | null },
): Promise<Response> {
  const { metaWebhookEventId } = opts;
  const entries = arr(body.entry);
  let skipReason: string | null = null;

  for (const entry of entries) {
    const e = obj(entry);
    const changes = arr(e.changes);

    for (const change of changes) {
      const ch = obj(change);
      const field = str(ch.field);
      const value = obj(ch.value);
      const metadata = obj(value.metadata);
      const phoneNumberId = str(metadata.phone_number_id);
      let inboundPaused = false;
      let inboundPausedName = "";
      let inboundPausedStatus = "";

      if (phoneNumberId) {
        if (shouldDropMetaInbound(phoneNumberId)) {
          skipReason = `ignored_phone ${phoneNumberId}`;
          log.warn(
            `inbound ignorado — número aposentado/ignorado phone=${phoneNumberId}`,
          );
          continue;
        }
        const inboundChannel = await findChannelByPhoneNumberId(phoneNumberId);
        // So DISCONNECTED/FAILED param inbound. CONNECTING (o "Conectar"
        // do CRM) e CONNECTED passam — senao o reconnect vira buraco negro
        // e o worker marca processed sem gravar. Recibos (status) sempre
        // processam: o gate antigo pulava o change inteiro e o tick ficava
        // preso em sent.
        inboundPaused =
          inboundChannel != null &&
          (inboundChannel.status === "DISCONNECTED" ||
            inboundChannel.status === "FAILED");
        if (inboundPaused) {
          inboundPausedName = inboundChannel.name;
          inboundPausedStatus = inboundChannel.status;
        }
        const isKnown = inboundChannel != null || (await isKnownPhoneNumberId(phoneNumberId));
        if (!isKnown) {
          const envPhoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "(none)";
          const knownChannels = await prisma.channel.findMany({
            where: { type: "WHATSAPP", provider: "META_CLOUD_API" },
            select: { id: true, name: true, config: true },
          });
          const knownIds = knownChannels
            .map((ch) => {
              const cfg = (ch.config ?? {}) as Record<string, unknown>;
              const id = typeof cfg.phoneNumberId === "string" ? cfg.phoneNumberId : null;
              return id ? `${ch.name}=${id}` : `${ch.name}=(nenhum)`;
            })
            .join(", ");
          skipReason = `unknown_phone ${phoneNumberId}`;
          log.debug(
            `phone_number_id="${phoneNumberId}" não reconhecido — número não cadastrado como canal. env=${envPhoneId}. Canais: [${knownIds || "(nenhum)"}]`,
          );
          continue;
        }
      } else {
        log.debug("metadata.phone_number_id ausente no payload");
      }

      if (field === "calls") {
        try {
          await processMetaWhatsappCallsWebhook(value, phoneNumberId, {
            resolveWebhookContact,
            findOrCreateConversation,
          });
        } catch (err) {
          log.error("Erro ao processar webhook de chamadas:", err);
        }
        continue;
      }

      if (field !== "messages") continue;

      const contacts = arr(value.contacts);
      const messages = arr(value.messages);
      const statuses = arr(value.statuses);

      // Duas leituras em lote no lugar de 2 `findFirst` por status; a
      // ordem de processamento do laço continua a mesma.
      const statusCache = await prefetchStatusBatch(statuses);
      for (const s of statuses) {
        await processStatusUpdate(obj(s), statusCache);
      }

      const contactMap = new Map<string, string>();
      // @ do WhatsApp: `contacts[].profile.username` (só presente quando o
      // usuário adotou username). Chaveamos por wa_id e user_id igual ao nome.
      const usernameMap = new Map<string, string>();
      for (const c of contacts) {
        const co = obj(c);
        const waId = str(co.wa_id);
        const userId = str(co.user_id);
        const profile = obj(co.profile);
        const name = str(profile.name) || str(profile.username);
        const username = str(profile.username);
        if (waId && name) contactMap.set(waId, name);
        if (userId && name) contactMap.set(userId, name);
        if (waId && username) usernameMap.set(waId, username);
        if (userId && username) usernameMap.set(userId, username);
      }

      for (const msg of messages) {
        const m = obj(msg);
        const msgType = str(m.type);
        let from = str(m.from);
        let fromUserId = str(m.from_user_id);
        if (!from && !fromUserId && msgType === "system") {
          const sys = obj(m.system);
          const sysWa = str(sys.wa_id);
          const sysUid = str(sys.user_id);
          if (sysWa) from = sysWa;
          if (sysUid) fromUserId = sysUid;
        }
        if (!from && !fromUserId && contacts.length === 1) {
          const co = obj(contacts[0]);
          if (!from) from = str(co.wa_id);
          if (!fromUserId) fromUserId = str(co.user_id);
        }
        if (!from && !fromUserId) continue;

        if (inboundPaused) {
          skipReason = `channel_${inboundPausedStatus} ${phoneNumberId}`;
          log.warn(
            `inbound ignorado — canal "${inboundPausedName}" status=${inboundPausedStatus} phone=${phoneNumberId}`,
          );
          continue;
        }

        const parsed = parseMessage(m);
        if (!parsed) continue;

        if (isDuplicate(parsed.waMessageId)) {
          log.debug(`Mensagem duplicada ignorada: ${parsed.waMessageId}`);
          continue;
        }

        if (isStaleMetaInbound(parsed.timestamp)) {
          const ageMin = Math.round(
            (Date.now() - parsed.timestamp.getTime()) / 60_000,
          );
          skipReason = `stale_inbound ageMin=${ageMin} phone=${phoneNumberId ?? "?"}`;
          log.warn(
            `inbound stale ignorado wamid=${parsed.waMessageId} ageMin=${ageMin} phone=${phoneNumberId ?? "?"}`,
          );
          continue;
        }

        // Reação inbound: atualiza JSON `reactions` do Message alvo em
        // vez de criar uma Message nova. O alvo é identificado pelo wamid
        // (externalId). Se não existir localmente (raro), apenas ignora.
        if (parsed.reactionTarget) {
          try {
            await applyIncomingReaction({
              targetWaMessageId: parsed.reactionTarget.targetWaMessageId,
              emoji: parsed.reactionTarget.emoji,
              fromWaId: from || fromUserId || "",
              at: parsed.timestamp,
            });
          } catch (err) {
            log.warn(
              `Falha ao aplicar reação (wamid=${parsed.reactionTarget.targetWaMessageId}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          continue;
        }

        try {
          const profileName =
            (from && contactMap.get(from)) ||
            (fromUserId && contactMap.get(fromUserId)) ||
            null;
          const profileUsername =
            (from && usernameMap.get(from)) ||
            (fromUserId && usernameMap.get(fromUserId)) ||
            null;

          // Tratamento especial para mensagens de sistema "user_changed_number":
          // o payload vem com o NOVO wa_id/BSUID, e se o contato antigo não
          // tinha BSUID salvo (ou o Meta trocou user_id entre os eventos),
          // a resolução padrão criaria um LEAD NOVO e dispararia automações
          // de boas-vindas. Aqui tentamos localizar o contato ANTIGO pelo
          // `oldPhone` extraído do body ("FROM x TO y"); se acharmos, usamos
          // ele. Se não, pulamos a mensagem em vez de criar lead espúrio.
          let contact: CrmContact | null = null;
          const sysEvent =
            msgType === "system" ? extractSystemEvent(m) : null;
          const isPhoneChangeEvent = sysEvent?.kind === "user_changed_number";
          if (sysEvent?.kind === "user_changed_number") {
            const oldDigits = (sysEvent.oldPhone ?? "").replace(/\D/g, "");
            if (oldDigits.length >= 10) {
              const normalizedOld = normalizePhone(oldDigits);
              const byOld = await prisma.contact.findFirst({
                where: { phone: normalizedOld },
                select: {
                  id: true,
                  name: true,
                  phone: true,
                  whatsappBsuid: true,
                  whatsappUsername: true,
                },
              });
              if (byOld) {
                contact = {
                  id: byOld.id,
                  name: byOld.name,
                  phone: byOld.phone ?? null,
                  whatsappBsuid: byOld.whatsappBsuid ?? null,
                  whatsappUsername: byOld.whatsappUsername ?? null,
                };
                log.info(
                  `Troca de número: contato antigo ${byOld.id} localizado pelo oldPhone ${normalizedOld} → novo ${sysEvent.newPhone ?? "?"}`,
                );
              }
            }
            if (!contact) {
              // Fallback: tenta BSUID/novo telefone, mas SEM criar lead.
              contact = await resolveWebhookContact(
                from || undefined,
                fromUserId || undefined,
                profileName,
                phoneNumberId || undefined,
                { createIfMissing: false, username: profileUsername },
              );
            }
            if (!contact) {
              log.warn(
                `Ignorando system user_changed_number: não foi possível localizar contato antigo (old=${sysEvent.oldPhone ?? "?"} new=${sysEvent.newPhone ?? "?"} bsuid=${fromUserId || "?"})`,
              );
              continue;
            }
          }

          if (!contact) {
            contact = await resolveWebhookContact(
              from || undefined,
              fromUserId || undefined,
              profileName,
              phoneNumberId || undefined,
              { username: profileUsername },
            );
          }
          // Evita warning de variável unused quando o fluxo principal
          // não precisa do flag (consumidores futuros podem usar).
          void isPhoneChangeEvent;
          try {
            // Tracking de anúncios: salva referral na primeira mensagem do contato
            // (ctwa_clid é único por clique — não sobrescreve se já preenchido)
            if (parsed.referral) {
              const ref = parsed.referral;
              const fullContact = await prisma.contact.findUnique({
                where: { id: contact.id },
                select: { adSourceId: true, adCtwaClid: true, adHeadline: true, source: true },
              });
              const needsUpdate =
                (ref.sourceId && !fullContact?.adSourceId) ||
                (ref.ctwaClid && !fullContact?.adCtwaClid);
              if (needsUpdate) {
                await prisma.contact.update({
                  where: { id: contact.id },
                  data: {
                    ...(ref.sourceId && !fullContact?.adSourceId
                      ? { adSourceId: ref.sourceId, adSourceType: ref.sourceType }
                      : {}),
                    ...(ref.ctwaClid && !fullContact?.adCtwaClid
                      ? { adCtwaClid: ref.ctwaClid }
                      : {}),
                    ...(ref.headline && !fullContact?.adHeadline
                      ? { adHeadline: ref.headline }
                      : {}),
                    ...(ref.headline &&
                    (!fullContact?.source || fullContact.source === "WhatsApp")
                      ? { source: `Anúncio: ${ref.headline.slice(0, 100)}` }
                      : {}),
                  },
                });
                log.info(
                  `Referral de anúncio salvo — contato=${contact.id} adId=${ref.sourceId ?? "—"} ctwa=${ref.ctwaClid ?? "—"} headline="${ref.headline ?? "—"}"`,
                );
              }

              // Resolução do ad + UTMs via Marketing API (ad ou post promovido).
              // Fire-and-forget: não atrasa o 200 OK pra Meta.
              if (ref.sourceId) {
                const orgId = getOrgIdOrNull();
                if (orgId) {
                  const token = await resolveAccessToken(
                    phoneNumberId || undefined,
                  );
                  void resolveAdAndPersistAsync({
                    contactId: contact.id,
                    organizationId: orgId,
                    sourceId: ref.sourceId,
                    sourceType: ref.sourceType,
                    accessToken: token,
                    sourceUrl: ref.sourceUrl,
                  });
                }
              } else if (ref.sourceUrl) {
                // Sem source_id mas com source_url — ainda extrai UTMs da URL.
                const orgId = getOrgIdOrNull();
                if (orgId) {
                  void resolveAdAndPersistAsync({
                    contactId: contact.id,
                    organizationId: orgId,
                    sourceId: `url:${contact.id}`,
                    sourceType: null,
                    accessToken: null,
                    sourceUrl: ref.sourceUrl,
                  });
                }
              }
            }
          } catch (err) {
            log.warn("Falha ao salvar referral de anúncio (não-fatal):", err);
          }
          const conversation = await findOrCreateConversation(contact.id, phoneNumberId || undefined);

          let mediaUrl = parsed.mediaUrl;
          if (!mediaUrl && parsed.mediaId) {
            // PR 1.3: passamos organizationId para storage tenant-scoped.
            mediaUrl = await downloadAndSaveMedia(
              parsed.mediaId,
              parsed.mimeType,
              conversation.organizationId,
              phoneNumberId || undefined,
            );
          }

          const isSystemMessage = parsed.type === "system";

          const inboundMsgType =
            isSystemMessage
              ? "system"
              : parsed.type === "unsupported"
                ? "unsupported"
                : parsed.mediaId
                  ? parsed.type
                  : parsed.type === "interactive" || parsed.type === "button"
                    ? "interactive"
                    : "text";

          // Resolve o alvo da citação (reply) ANTES da transação — evita
          // manter a tx aberta pra query custosa e permite fallback silencioso
          // quando o alvo não existe no CRM (ex.: cliente respondeu uma
          // mensagem enviada por outro canal ou anterior à integração).
          const replyLink = parsed.replyToWaMessageId
            ? await resolveReplyContext(parsed.replyToWaMessageId)
            : null;

          const msgCreated = await prisma.$transaction(async (tx) => {
              const existing = await tx.message.findFirst({
              where: { externalId: parsed.waMessageId },
              select: { id: true },
            });
            if (existing) return null;

            return tx.message.create({
              data: withOrgFromCtx({
                conversationId: conversation.id,
                channelId: conversation.channelId ?? undefined,
                content: parsed.text,
                direction: isSystemMessage ? "system" : "in",
                messageType: inboundMsgType,
                externalId: parsed.waMessageId,
                senderName: isSystemMessage ? "WhatsApp" : (profileName || contact.name),
                mediaUrl,
                createdAt: parsed.timestamp,
                ...(replyLink
                  ? {
                      replyToId: replyLink.messageId,
                      replyToPreview: replyLink.preview,
                    }
                  : {}),
              }),
            });
          });

          if (!msgCreated) {
            // Reentrega da Meta: a linha já existe, mas o grant pode ter
            // falhado no ingest anterior. Sem isso o chat mostra
            // "Cliente aceitou" e o botão de ligar fica cinza.
            if (!isSystemMessage) {
              try {
                const consentPayload = {
                  type: parsed.type,
                  interactiveButtonId: parsed.interactiveButtonId,
                  interactiveButtonTitle: parsed.interactiveButtonTitle,
                  interactiveKind: parsed.interactiveKind,
                  text: parsed.text,
                  callPermissionType: parsed.callPermissionType,
                };
                const granted = await maybeGrantWhatsappCallConsent(
                  conversation.id,
                  consentPayload,
                );
                if (granted) {
                  sseBus.publish("conversation_updated", {
                    organizationId: getOrgIdOrNull(),
                    conversationId: conversation.id,
                    contactId: contact.id,
                    whatsappCallConsentStatus: "GRANTED",
                  });
                } else {
                  const denied = await maybeDenyWhatsappCallConsent(
                    conversation.id,
                    consentPayload,
                  );
                  if (denied) {
                    sseBus.publish("conversation_updated", {
                      organizationId: getOrgIdOrNull(),
                      conversationId: conversation.id,
                      contactId: contact.id,
                      whatsappCallConsentStatus: "DENIED",
                    });
                  }
                }
              } catch (err) {
                log.warn("Falha ao atualizar consent de ligação (duplicata):", err);
              }
            }
            continue;
          }

          // Activity Log: registra MESSAGE_RECEIVED no feed unificado.
          // Mensagens "system" do WhatsApp (ex.: user_changed_number)
          // tambem entram para auditoria — actor INTEGRATION nos dois
          // casos (no system, sublabel reflete a origem).
          if (!isSystemMessage) {
            void (async () => {
              const openDeal = await prisma.deal.findFirst({
                where: { contactId: contact.id, status: "OPEN" },
                select: { id: true },
                orderBy: { updatedAt: "desc" },
              }).catch(() => null);
              await logEvent({
                type: "MESSAGE_RECEIVED",
                entityType: "MESSAGE",
                entityId: msgCreated.id,
                entityLabel: profileName || contact.name || "Mensagem recebida",
                conversationId: conversation.id,
                contactId: contact.id,
                dealId: openDeal?.id ?? null,
                actor: {
                  type: "INTEGRATION",
                  label: contact.name ?? profileName ?? "Contato",
                  sublabel: contact.phone ?? "WhatsApp",
                  ref: contact.id,
                },
                meta: {
                  preview: (parsed.text ?? "").slice(0, 200),
                  channel: "WhatsApp",
                  via: "meta_cloud_api",
                  messageType: inboundMsgType,
                  externalId: parsed.waMessageId,
                },
              });
            })();
          }

          // Campanhas: correlaciona a resposta inbound ao disparo de campanha
          // mais recente do contato (marca repliedAt + incrementa repliedCount).
          // Fire-and-forget — não bloqueia o processamento da mensagem.
          if (!isSystemMessage) {
            markCampaignReplyByContact(contact.id, parsed.timestamp ?? new Date()).catch(
              (err) =>
                log.warn("Falha ao correlacionar resposta de campanha:", err),
            );
          }

          if (parsed.flowPayload && Object.keys(parsed.flowPayload).length > 0) {
            try {
              const flowApply = await applyWhatsappFlowResponseToContact({
                contactId: contact.id,
                conversationId: conversation.id,
                organizationId: conversation.organizationId,
                flowPayload: parsed.flowPayload,
                flowMetaName: parsed.flowMetaName,
                flowToken: parsed.flowToken,
                channelRef: conversation.channelId
                  ? { id: conversation.channelId, provider: "META_CLOUD_API" }
                  : null,
                waJid: null,
              });
              if (flowApply.alerts.length > 0) {
                log.warn("[whatsapp-flow] alertas na aplicação", {
                  contactId: contact.id,
                  alerts: flowApply.alerts,
                });
              }
            } catch (err) {
              log.error("[whatsapp-flow] falha ao aplicar resposta no lead (não-fatal):", err);
            }
          }

          // Inbound do cliente cancela automaticamente qualquer mensagem
          // agendada pendente para esta conversa (cliente respondeu antes
          // do envio programado). Ignorado para mensagens de sistema.
          if (!isSystemMessage) {
            cancelPendingForConversation(conversation.id, "client_reply").catch(
              (err) =>
                log.warn("Falha ao cancelar agendamentos pendentes:", err),
            );
          }

          if (isSystemMessage) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { updatedAt: new Date() },
            }).catch(() => {});
            log.debug(`Mensagem de sistema WhatsApp: ${parsed.text.substring(0, 120)}`);

            // Detecta troca de número (`user_changed_number`) e: atualiza
            // o telefone do contato, grava o log auditável e dispara SSE.
            // Roda em try/catch isolado pra que falha aqui NUNCA derrube
            // a ingestão da mensagem em si.
            try {
              if (sysEvent && parsed.waMessageId) {
                await applyContactPhoneChange({
                  contactId: contact.id,
                  currentPhone: contact.phone,
                  currentBsuid: contact.whatsappBsuid,
                  currentName: contact.name,
                  event: sysEvent,
                  messageExternalId: parsed.waMessageId,
                });
              }
            } catch (err) {
              log.warn("Falha ao processar troca de número (não-fatal):", err);
            }
          } else {
            try {
              const consentPayload = {
                type: parsed.type,
                interactiveButtonId: parsed.interactiveButtonId,
                interactiveButtonTitle: parsed.interactiveButtonTitle,
                interactiveKind: parsed.interactiveKind,
                text: parsed.text,
                callPermissionType: parsed.callPermissionType,
              };
              const granted = await maybeGrantWhatsappCallConsent(
                conversation.id,
                consentPayload,
              );
              if (granted) {
                sseBus.publish("conversation_updated", {
                  organizationId: getOrgIdOrNull(),
                  conversationId: conversation.id,
                  contactId: contact.id,
                  whatsappCallConsentStatus: "GRANTED",
                });
              } else {
                // Se não virou GRANTED, pode ter sido um decline: derruba o
                // consent para DENIED (cobre "REQUESTED → DENIED" e também
                // revogação pós-aceite "GRANTED → DENIED").
                const denied = await maybeDenyWhatsappCallConsent(
                  conversation.id,
                  consentPayload,
                );
                if (denied) {
                  sseBus.publish("conversation_updated", {
                    organizationId: getOrgIdOrNull(),
                    conversationId: conversation.id,
                    contactId: contact.id,
                    whatsappCallConsentStatus: "DENIED",
                  });
                }
              }
            } catch (err) {
              log.warn("Falha ao atualizar consent de ligação (não-fatal):", err);
            }

            const inboundAt = parsed.timestamp ?? new Date();
            try {
              await prisma.conversation.update({
                where: { id: conversation.id },
                data: {
                  updatedAt: new Date(),
                  unreadCount: { increment: 1 },
                  lastMessageDirection: "in",
                  hasAgentReply: false,
                  // Cliente respondeu → sai da fila Erro (fase adequada).
                  hasError: false,
                },
              });
            } catch {
              // Fallback ainda limpa Erro + direção — senão race com
              // webhook `failed` deixa a conversa presa em Erro.
              await prisma.conversation.update({
                where: { id: conversation.id },
                data: {
                  updatedAt: new Date(),
                  unreadCount: { increment: 1 },
                  lastMessageDirection: "in",
                  hasError: false,
                },
              }).catch(() => {});
            }
            await touchInbound({ conversationId: conversation.id, at: inboundAt }).catch((err) =>
              warnTouchInboundFailed(err, {
                conversationId: conversation.id,
                channel: conversation.channel ?? "whatsapp",
              }),
            );

            try {
              sseBus.publish("new_message", {
                organizationId: getOrgIdOrNull(),
                conversationId: conversation.id,
                contactId: contact.id,
                direction: "in",
                assignedToId: conversation.assignedToId ?? null,
                content: parsed.text,
                timestamp: parsed.timestamp,
              });
            } catch (err) {
              log.debug("Falha ao publicar SSE (não-fatal):", err);
            }

            // Push notification ao operador (PWA — funciona com app
            // fechado). Disparado em background pra nao atrasar 200
            // OK do webhook (Meta tem janela de retry curta).
            notifyInboundMessage({
              conversationId: conversation.id,
              contactId: contact.id,
              contactName: contact.name,
              preview: parsed.text || "[mídia]",
              channel: "WhatsApp",
            }).catch((err) =>
              log.debug("Falha ao enviar push (não-fatal):", err),
            );

            // 1º atendimento IA ANTES do salesbot/INICIO-PIPE (allowlist).
            try {
              await ensureInboundAiAttendance({
                conversationId: conversation.id,
                contactId: contact.id,
              });
            } catch (err) {
              log.error("Falha no ensureInboundAiAttendance:", err);
            }

            let salesbotReplied = false;
            try {
              const isFlowReply =
                parsed.interactiveKind === "nfm_reply" ||
                parsed.interactiveKind === "flow_reply" ||
                Boolean(parsed.flowPayload && Object.keys(parsed.flowPayload).length > 0);
              const salesbotResult = await processSalesbotMessage(contact.id, parsed.text, {
                interactiveId: parsed.interactiveButtonId,
                channelId: conversation.channelId,
                conversationId: conversation.id,
                flowReply: isFlowReply,
                flowToken: parsed.flowToken,
                flowPayload: parsed.flowPayload,
              });
              salesbotReplied = Boolean(salesbotResult?.replied);
            } catch (err) {
              log.error("Falha no salesbot:", err);
            }

            try {
              await fireTrigger("message_received", {
                contactId: contact.id,
                data: buildMessageTriggerData({
                  channel: "WhatsApp",
                  channelId: conversation.channelId,
                  conversationId: conversation.id,
                  content: parsed.text,
                  extra: {
                    phoneNumberId,
                    waMessageId: parsed.waMessageId,
                    metaWebhookEventId,
                    ...(parsed.flowPayload
                      ? {
                          flowResponse: parsed.flowPayload,
                          flowMetaName: parsed.flowMetaName,
                          flowToken: parsed.flowToken,
                        }
                      : {}),
                  },
                }),
              });
            } catch (err) {
              log.error("Falha ao disparar gatilho message_received:", err);
            }

            // Agente de IA: agenda resposta com debounce (agrupa msgs consecutivas).
            // Quando o salesbot RESPONDEU (clique de botão casado com automação
            // pausada), a IA NÃO fala — a resposta era insumo do fluxo, não uma
            // pergunta pro agente. Mas quando ele só encerrou o robô (handoff
            // por texto livre / ponteiro morto) ninguém falou com o aluno:
            // silenciar a IA aí deixava a mensagem sem nenhuma resposta.
            if (!isSystemMessage && parsed.text && !salesbotReplied) {
              void scheduleAiReply({
                conversationId: conversation.id,
                contactId: contact.id,
                messageId: msgCreated.id,
                userMessage: parsed.text,
                channel: "meta",
              });
            }

            log.info(`Mensagem de ${contact.name}: ${parsed.text.substring(0, 60)}`);
          }
        } catch (err) {
          log.error("Erro ao processar mensagem:", err);
        }
      }
    }
  }

  if (metaWebhookEventId) {
    await markWebhookEventProcessed(metaWebhookEventId, skipReason);
  }

  return NextResponse.json({ status: "ok" });
}

/**
 * Reprocessa um MetaWebhookEvent persistido (usado pelo worker-meta-webhook).
 * Carrega o `rawBody`, resolve o tenant e executa o loop de processamento
 * dentro de `withSystemContext`. Idempotente: se já `processed`, no-op.
 */
export async function processStoredMetaWebhookEvent(
  metaWebhookEventId: string,
): Promise<void> {
  const event = await prismaBase.metaWebhookEvent.findUnique({
    where: { id: metaWebhookEventId },
    select: { id: true, organizationId: true, rawBody: true, processed: true },
  });
  if (!event) {
    throw new Error(`MetaWebhookEvent ${metaWebhookEventId} não encontrado`);
  }
  if (event.processed) {
    log.debug(`MetaWebhookEvent ${metaWebhookEventId} já processado — skip`);
    return;
  }
  if (!event.organizationId) {
    await markWebhookEventProcessed(metaWebhookEventId, "no_organization");
    return;
  }
  await withSystemContext(event.organizationId, async () => {
    await processMetaWebhookPayload(
      event.rawBody as Record<string, unknown>,
      { metaWebhookEventId },
    );
  });
}

// ─── Auditoria do webhook Meta ────────────────────────────────
// Captura o payload bruto + headers relevantes do POST e gera um
// MetaWebhookEvent. O ID é propagado via context.data.metaWebhookEventId
// até o `automation_logs.metaWebhookEventId`, permitindo que a UI da
// automação exiba o JSON original entregue pela Meta.

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

function summarizeFirstMessage(body: Record<string, unknown>): {
  eventType: string;
  phoneNumberId: string | null;
  waMessageId: string | null;
  fromPhone: string | null;
} {
  let eventType = "unknown";
  let phoneNumberId: string | null = null;
  let waMessageId: string | null = null;
  let fromPhone: string | null = null;

  const entries = arr(body.entry);
  for (const entry of entries) {
    const e = obj(entry);
    const changes = arr(e.changes);
    for (const change of changes) {
      const ch = obj(change);
      const field = str(ch.field);
      const value = obj(ch.value);
      const metadata = obj(value.metadata);
      const pid = str(metadata.phone_number_id);
      if (pid && !phoneNumberId) phoneNumberId = pid;

      if (field === "messages") {
        const messages = arr(value.messages);
        if (messages.length > 0) {
          eventType = "message";
          const m = obj(messages[0]);
          const id = str(m.id);
          const from = str(m.from);
          if (id) waMessageId = id;
          if (from) fromPhone = from;
        } else if (arr(value.statuses).length > 0) {
          eventType = eventType === "unknown" ? "status" : eventType;
        }
      } else if (field) {
        eventType = eventType === "unknown" ? field : eventType;
      }
    }
  }

  return { eventType, phoneNumberId, waMessageId, fromPhone };
}

async function createMetaWebhookEvent(args: {
  rawBody: Record<string, unknown>;
  headers: Record<string, string>;
  signatureValid: boolean;
  scope: WebhookScope | undefined;
}): Promise<string | null> {
  const { rawBody, headers, signatureValid, scope } = args;
  const summary = summarizeFirstMessage(rawBody);

  // Resolve channelId best-effort pelo phoneNumberId.
  let channelId: string | null = null;
  let organizationId: string | null = scope?.organizationId ?? null;
  if (summary.phoneNumberId) {
    try {
      const channel = await prismaBase.channel.findFirst({
        where: {
          type: "WHATSAPP",
          provider: "META_CLOUD_API",
          config: { path: ["phoneNumberId"], equals: summary.phoneNumberId },
        },
        select: { id: true, organizationId: true },
      });
      if (channel) {
        channelId = channel.id;
        if (!organizationId) organizationId = channel.organizationId;
      }
    } catch (err) {
      log.debug("Falha ao resolver channel para webhook event (não-fatal):", err);
    }
  }

  try {
    const created = await prismaBase.metaWebhookEvent.create({
      data: {
        organizationId: organizationId ?? null,
        channelId,
        signatureValid,
        objectType: str(rawBody.object) || null,
        eventType: summary.eventType,
        phoneNumberId: summary.phoneNumberId,
        waMessageId: summary.waMessageId,
        fromPhone: summary.fromPhone,
        rawBody: rawBody as Prisma.InputJsonValue,
        headers: headers as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    log.error("Falha ao persistir MetaWebhookEvent (não-fatal):", err);
    return null;
  }
}

async function markWebhookEventProcessed(
  id: string,
  errorMessage: string | null,
): Promise<void> {
  try {
    await prismaBase.metaWebhookEvent.update({
      where: { id },
      data: {
        processed: true,
        processingError: errorMessage,
      },
    });
  } catch (err) {
    log.debug("Falha ao marcar MetaWebhookEvent como processado (não-fatal):", err);
  }
}

