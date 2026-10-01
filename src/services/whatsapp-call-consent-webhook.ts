import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { fireTrigger } from "@/services/automation-triggers";
import {
  getCallPermissionAcceptButtonIds,
  getCallPermissionAcceptButtonTitlesFromEnv,
} from "@/lib/call-permission-env";
import { getLogger } from "@/lib/logger";

const log = getLogger("whatsapp-call-consent-webhook");

/** Títulos comuns do botão de templates de permissão de chamada (PT/EN). */
const BUILTIN_ACCEPT_TITLE_SNIPPETS = [
  "sempre permitir ligações",
  "sempre permitir ligacoes",
  "sempre permitir",
  "permitir ligações",
  "permitir ligacoes",
  "permitir chamadas",
  "permitir ligação",
  "permitir ligacao",
  "autorizar ligações",
  "autorizar ligacoes",
  "sim, permitir",
  "always allow calls",
  "always allow",
  "allow calls",
];

/** Evita falsos positivos em frases como “não permitir ligações”. */
const TITLE_HEURISTIC =
  /^sempre\s+permitir(\s+liga|\s*$)|^permitir\s+as\s+liga|^permitir\s+liga|always\s+allow(\s+calls)?$/i;

/** Heurística para decidir o tipo da permissão a partir do título do botão. */
function deriveConsentTypeFromTitle(title: string): "PERMANENT" | "TEMPORARY" {
  const t = title.toLowerCase();
  if (t.includes("sempre") || t.includes("always")) return "PERMANENT";
  return "TEMPORARY";
}

export type CallConsentWebhookParsed = {
  type: string;
  interactiveButtonId: string | null;
  interactiveButtonTitle: string | null;
  interactiveKind: string | null;
  text: string;
  /**
   * Vindo direto de `interactive.call_permission_reply.permission_type`. Se
   * presente, é a fonte de verdade para o tipo da permissão. Null quando a
   * Meta não envia (webhooks de botões genéricos, texto livre, etc.) — aí
   * caímos em heurística sobre o título do botão.
   */
  callPermissionType?: "PERMANENT" | "TEMPORARY" | null;
};

/** Prazo fixo da Meta para opt-in temporário (Cloud API Calling). */
const TEMPORARY_CONSENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function blob(parsed: CallConsentWebhookParsed): string {
  return `${parsed.text} ${parsed.interactiveButtonTitle ?? ""} ${parsed.interactiveKind ?? ""}`.toLowerCase();
}

/** Recusa explícita (botão ou texto parseado). */
function isCallPermissionDecline(parsed: CallConsentWebhookParsed): boolean {
  const t = (parsed.text ?? "").toLowerCase();
  if (t.includes("❌") || t.includes("recusou")) return true;
  const b = blob(parsed);
  if (b.includes("não permitir") || b.includes("nao permitir")) return true;
  if (b.includes("don't allow") || b.includes("dont allow")) return true;
  if (b.includes("deny") && !b.includes("always")) return true;
  if (/\brecus(ar|e)\b/.test(b) && !b.includes("aceit")) return true;
  // "REJECT"/"REJECTED" aparecem quando a Meta manda só o status cru no
  // `call_permission_reply.response` — nosso formatter no webhook chegou a
  // cair no fallback genérico ("📞 Resposta ao pedido de ligações: REJECT")
  // sem traduzir, então o decline precisa reconhecer essa forma.
  if (/\breject(ed)?\b/.test(b)) return true;
  return false;
}

/** Aceite a partir do texto gerado pelo nosso parser (call_permission_reply). */
function isCallPermissionAcceptFromParsedText(parsed: CallConsentWebhookParsed): boolean {
  const t = (parsed.text ?? "").toLowerCase();
  if (t.includes("✅") && (t.includes("aceitou") || t.includes("concedida"))) return true;
  if (t.includes("permissão para ligações concedida") || t.includes("permissao para ligacoes concedida")) {
    return true;
  }
  const u = t.toUpperCase();
  if (u.includes("GRANTED") || u.includes("ACCEPTED") || u.includes("APPROVED")) {
    if (u.includes("REJECT") || u.includes("DECLIN")) return false;
    if (parsed.interactiveKind?.toLowerCase().includes("call_permission")) return true;
  }
  return false;
}

/**
 * Atualiza opt-in para GRANTED quando o webhook de mensagem reflete aceite do cliente.
 * Trata `button_reply` (botões do template na Meta) e `call_permission_reply`.
 */
export async function maybeGrantWhatsappCallConsent(
  conversationId: string,
  parsed: CallConsentWebhookParsed
): Promise<boolean> {
  if (parsed.type === "system") return false;

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { whatsappCallConsentStatus: true, channel: true },
  });
  if (!conv || conv.channel !== "whatsapp") return false;

  if (isCallPermissionDecline(parsed)) return false;

  const isRequested = conv.whatsappCallConsentStatus === "REQUESTED";
  const kindEarly = (parsed.interactiveKind ?? "").toLowerCase();
  const strongAccept =
    isCallPermissionAcceptFromParsedText(parsed) ||
    kindEarly.includes("call_permission");

  if (isCallPermissionAcceptFromParsedText(parsed)) {
    // Inferir tipo a partir do texto parseado pelo webhook
    // ("... (permanente)" vs "... por 7 dias").
    const t = (parsed.text ?? "").toLowerCase();
    const inferredType: "PERMANENT" | "TEMPORARY" =
      parsed.callPermissionType ??
      (t.includes("permanen") ? "PERMANENT" : "TEMPORARY");
    await applyGrant(conversationId, inferredType);
    return true;
  }

  const acceptIds = getCallPermissionAcceptButtonIds();
  const acceptTitlesEnv = getCallPermissionAcceptButtonTitlesFromEnv();

  const titleBtn = (parsed.interactiveButtonTitle ?? "").trim().toLowerCase();
  const titleText = (parsed.text ?? "").trim().toLowerCase();
  const combined = titleBtn || titleText;
  const kind = (parsed.interactiveKind ?? "").toLowerCase();

  let grant = strongAccept;

  if (!grant && isRequested && parsed.interactiveButtonId && acceptIds.length > 0) {
    grant = acceptIds.includes(parsed.interactiveButtonId);
  }

  if (!grant && isRequested && acceptTitlesEnv.length > 0 && combined) {
    grant = acceptTitlesEnv.some((t) => {
      const x = t.trim().toLowerCase();
      return x.length > 0 && (combined === x || combined.includes(x));
    });
  }

  if (!grant && isRequested && (parsed.type === "interactive" || parsed.type === "button")) {
    if (combined) {
      if (BUILTIN_ACCEPT_TITLE_SNIPPETS.some((s) => combined.includes(s))) {
        grant = true;
      }
      if (!grant && TITLE_HEURISTIC.test(combined)) {
        grant = true;
      }
    }
    if (
      !grant &&
      kind.includes("call_permission") &&
      !isCallPermissionDecline(parsed) &&
      (combined.length > 0 || Boolean(parsed.interactiveButtonId))
    ) {
      grant = true;
    }
  }

  if (!grant) return false;

  // Tipo vem (em ordem de preferência): payload estruturado call_permission_reply
  // → título do botão (Sempre permitir = PERMANENT, Permitir temporariamente =
  // TEMPORARY) → default TEMPORARY (conservador: 7d é o menor risco).
  const inferredType: "PERMANENT" | "TEMPORARY" =
    parsed.callPermissionType ??
    (combined ? deriveConsentTypeFromTitle(combined) : "TEMPORARY");

  await applyGrant(conversationId, inferredType);
  return true;
}

/**
 * Escreve o grant com tipo + expiresAt.
 *
 * Usa `$executeRaw` nas 2 colunas novas (`whatsappCallConsentType` e
 * `whatsappCallConsentExpiresAt`) para ser resiliente à regeneração do
 * Prisma Client — o dev server local trava `query_engine.dll`, então
 * a migration corre no deploy sem o client necessariamente estar sincronizado.
 */
async function applyGrant(
  conversationId: string,
  type: "PERMANENT" | "TEMPORARY",
  opts?: { grantedAt?: Date; fireAutomation?: boolean },
): Promise<void> {
  const now = opts?.grantedAt ?? new Date();
  const expiresAt =
    type === "TEMPORARY" ? new Date(now.getTime() + TEMPORARY_CONSENT_TTL_MS) : null;

  const src = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      contactId: true,
      channel: true,
      organizationId: true,
      whatsappCallConsentStatus: true,
    },
  });
  if (!src) return;
  const previousStatus = src.whatsappCallConsentStatus;

  const targets = src.contactId
    ? await prisma.conversation.findMany({
        where: { contactId: src.contactId, channel: src.channel },
        select: { id: true },
      })
    : [{ id: conversationId }];
  const targetIds = (targets.length > 0 ? targets : [{ id: conversationId }]).map(
    (t) => t.id,
  );

  await prisma.conversation.updateMany({
    where: { id: { in: targetIds } },
    data: {
      whatsappCallConsentStatus: "GRANTED",
      whatsappCallConsentUpdatedAt: now,
      updatedAt: now,
    },
  });

  try {
    const orgId = getOrgIdOrThrow();
    if (expiresAt) {
      await prisma.$executeRaw`
        UPDATE "conversations"
        SET
          "whatsappCallConsentType" = ${type}::"WhatsappCallConsentType",
          "whatsappCallConsentExpiresAt" = ${expiresAt}
        WHERE "id" IN (${Prisma.join(targetIds)})
          AND "organizationId" = ${orgId}
      `;
    } else {
      await prisma.$executeRaw`
        UPDATE "conversations"
        SET
          "whatsappCallConsentType" = ${type}::"WhatsappCallConsentType",
          "whatsappCallConsentExpiresAt" = NULL
        WHERE "id" IN (${Prisma.join(targetIds)})
          AND "organizationId" = ${orgId}
      `;
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[whatsapp-call-consent] migration pendente para type/expiresAt",
    );
  }

  // Primeiro grant apenas: duplicata com status já GRANTED não re-dispara.
  // EXPIRED/DENIED/REQUESTED/NONE → GRANTED dispara. Ligação inbound
  // (USER_INITIATED) NÃO passa por aqui. Repair a partir da timeline
  // não dispara automação (o aceite já aconteceu).
  if (
    opts?.fireAutomation !== false &&
    previousStatus !== "GRANTED" &&
    src.contactId
  ) {
    void fireTrigger("call_permission_granted", {
      contactId: src.contactId,
      data: {
        conversationId,
        consentType: type,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        channel: "whatsapp",
      },
    }).catch((err) =>
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[whatsapp-call-consent] fireTrigger",
      ),
    );
  }
}

function isEffectiveGrant(
  status: string | null | undefined,
  type: "PERMANENT" | "TEMPORARY" | null | undefined,
  updatedAt: Date | null | undefined,
  expiresAt: Date | null | undefined,
): boolean {
  if (status !== "GRANTED") return false;
  if (type === "PERMANENT") return true;
  const exp =
    expiresAt ??
    (updatedAt ? new Date(updatedAt.getTime() + TEMPORARY_CONSENT_TTL_MS) : null);
  return !!exp && exp.getTime() > Date.now();
}

/**
 * Recupera GRANTED quando a timeline já tem "✅ Cliente aceitou" mas a
 * coluna da conversa ficou em REQUESTED/NONE (webhook duplicado, reenvio
 * de template que zerou o opt-in, etc.).
 *
 * Retorna true se persistiu um grant novo.
 */
export async function repairWhatsappCallConsentFromMessages(
  conversationId: string,
): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      contactId: true,
      channel: true,
      whatsappCallConsentStatus: true,
      whatsappCallConsentUpdatedAt: true,
    },
  });
  if (!conv || conv.channel !== "whatsapp") return false;

  if (
    isEffectiveGrant(
      conv.whatsappCallConsentStatus,
      null,
      conv.whatsappCallConsentUpdatedAt,
      null,
    )
  ) {
    return false;
  }

  const convIds = conv.contactId
    ? (
        await prisma.conversation.findMany({
          where: { contactId: conv.contactId, channel: "whatsapp" },
          select: { id: true },
        })
      ).map((c) => c.id)
    : [conversationId];
  if (convIds.length === 0) return false;

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const msg = await prisma.message.findFirst({
    where: {
      conversationId: { in: convIds },
      createdAt: { gte: since },
      OR: [
        { content: { contains: "Cliente aceitou", mode: "insensitive" } },
        { content: { contains: "Cliente recusou", mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { content: true, createdAt: true },
  });
  if (!msg?.content) return false;

  const t = msg.content.toLowerCase();
  if (t.includes("recusou")) return false;
  if (!t.includes("aceitou")) return false;

  const type: "PERMANENT" | "TEMPORARY" = t.includes("permanen")
    ? "PERMANENT"
    : "TEMPORARY";
  if (type === "TEMPORARY") {
    const exp = msg.createdAt.getTime() + TEMPORARY_CONSENT_TTL_MS;
    if (exp <= Date.now()) return false;
  }

  await applyGrant(conversationId, type, {
    grantedAt: msg.createdAt,
    fireAutomation: false,
  });
  return true;
}

/**
 * Garante GRANTED neste ticket antes de `POST .../whatsapp-calls` initiate.
 * O chip do header pode ficar verde pela timeline enquanto a coluna deste
 * ticket ainda está REQUESTED (reenvio de template, cópia só no GET de
 * calling-context). Sem isto a Meta nem é chamada: 403 local.
 */
export async function ensureWhatsappCallConsentForOutbound(
  conversationId: string,
): Promise<boolean> {
  try {
    await repairWhatsappCallConsentFromMessages(conversationId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[whatsapp-call-consent] repair on initiate",
    );
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      contactId: true,
      channel: true,
      whatsappCallConsentStatus: true,
    },
  });
  if (!conv || conv.channel !== "whatsapp") return false;
  if (conv.whatsappCallConsentStatus === "GRANTED") return true;

  if (!conv.contactId) return false;
  const sibling = await prisma.conversation.findFirst({
    where: {
      contactId: conv.contactId,
      channel: "whatsapp",
      whatsappCallConsentStatus: "GRANTED",
      id: { not: conversationId },
    },
    orderBy: { whatsappCallConsentUpdatedAt: "desc" },
    select: { whatsappCallConsentUpdatedAt: true },
  });
  if (!sibling) return false;

  await applyGrant(conversationId, "TEMPORARY", {
    grantedAt: sibling.whatsappCallConsentUpdatedAt ?? new Date(),
    fireAutomation: false,
  });
  return true;
}

/**
 * Atualiza opt-in para DENIED quando o webhook reflete recusa do cliente.
 *
 * Cobre tanto a resposta direta ao pedido (`REQUESTED` → `DENIED`) quanto o
 * caso do cliente revogar depois de já ter concedido (`GRANTED` → `DENIED`).
 * Sem isso, o chip de cabeçalho continuava mostrando a permissão antiga
 * mesmo após o REJECT chegar pelo webhook.
 */
export async function maybeDenyWhatsappCallConsent(
  conversationId: string,
  parsed: CallConsentWebhookParsed,
): Promise<boolean> {
  if (parsed.type === "system") return false;

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { whatsappCallConsentStatus: true, channel: true },
  });
  if (!conv || conv.channel !== "whatsapp") return false;

  if (!isCallPermissionDecline(parsed)) return false;

  const now = new Date();
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      whatsappCallConsentStatus: "DENIED",
      whatsappCallConsentUpdatedAt: now,
      updatedAt: now,
    },
  });

  try {
    const orgId = getOrgIdOrThrow();
    await prisma.$executeRaw`
      UPDATE "conversations"
      SET
        "whatsappCallConsentType" = NULL,
        "whatsappCallConsentExpiresAt" = NULL
      WHERE "id" = ${conversationId}
        AND "organizationId" = ${orgId}
    `;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[whatsapp-call-consent] migration pendente para type/expiresAt (deny)",
    );
  }

  return true;
}
