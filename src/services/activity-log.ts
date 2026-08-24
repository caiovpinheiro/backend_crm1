/**
 * Activity Log central (Kommo-grade) — log de atividade unificado.
 *
 * Substitui gradualmente `createDealEvent()`: este helper aceita
 * qualquer tipo de entidade-sujeito (DEAL, CONTACT, CONVERSATION, ...)
 * e resolve a atribuicao rica de ator a partir do `RequestContext`
 * (tipo + label + sublabel + ref).
 *
 * Caracteristicas:
 *   - Fire-and-forget: nunca derruba a request principal. Erros sao
 *     logados em console.warn e suprimidos.
 *   - Org-scoped: usa `withOrgFromCtx`, herdando a org da extension.
 *   - Idempotente em relacao ao ator: se nao houver `actor` no contexto,
 *     deriva um default sensato (HUMAN se houver `userId` real, SYSTEM
 *     caso contrario).
 *   - Sem dependencia circular: `services/deals.ts` pode importar e
 *     `createDealEvent` vira um wrapper fino sobre este.
 */

import type { ActorType, EventEntityType, Prisma } from "@prisma/client";

import { getAutomationOrigin } from "@/lib/automation-origin";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  getActorContext,
  getRequestContext,
  type ContextActor,
} from "@/lib/request-context";
import { mirrorConversationChatEvent } from "@/services/conversation-event-mirror";

/**
 * M7/M8 — quando `IMPORT_SKIP_ACTIVITY_LOG` está setado (truthy), suprime a
 * gravação de activity events. Deve ser configurado APENAS no processo do
 * etl-worker durante cargas em massa: cada linha de import gerava 1+ evento
 * (um por campo alterado no update), acumulando promises fire-and-forget que
 * competem pela conexão e inundam `activity_events`. No processo da API
 * (requests interativos) o flag NÃO deve ser setado.
 */
function shouldSkipActivityLog(): boolean {
  const v = process.env.IMPORT_SKIP_ACTIVITY_LOG;
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export type LogEventInput = {
  /// Tipo do evento (SCREAMING_SNAKE_CASE). Ex.: STAGE_CHANGED,
  /// MESSAGE_SENT, CONTACT_CREATED, OWNER_CHANGED, FIELD_CHANGED,
  /// TAG_ADDED, AUTOMATION_EXECUTED, AI_AGENT_HANDOFF.
  type: string;

  // ── Sujeito ────────────────────────────────────────────────────
  entityType: EventEntityType;
  entityId: string;
  /// Snapshot textual do sujeito (titulo do lead, "Lead #<number>",
  /// nome do contato, codigo da conversa). Recomendado para nao
  /// precisar de join na hora de renderizar o feed.
  entityLabel?: string | null;

  // Escopo secundario para filtros rapidos. Preencha o que fizer
  // sentido — ex.: mensagem nova num deal aberto do contato passa
  // os 3 (dealId, contactId, conversationId).
  dealId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;

  // ── Conteudo ───────────────────────────────────────────────────
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  meta?: Record<string, unknown>;

  // ── Override de ator (raro) ────────────────────────────────────
  /// Quando o caller sabe melhor que o contexto quem fez a acao
  /// (ex.: worker de automation que recebe o actor por payload),
  /// pode forcar aqui em vez de mexer no RequestContext.
  actor?: ContextActor;
};

/// Default seguro: se o contexto nao trouxer ator, infere a partir do
/// userId. Mantem a auditoria minimamente util mesmo em call-sites
/// que ainda nao foram migrados pra popular `actor`.
function resolveActor(input: LogEventInput): {
  actorType: ActorType;
  actorUserId: string | null;
  actorLabel: string | null;
  actorSublabel: string | null;
  actorRef: string | null;
} {
  const override = input.actor;
  const ctx = getRequestContext();
  const ctxActor = override ?? getActorContext();

  // userId real = nao e placeholder de webhook/system/cron
  const rawUserId = ctx?.userId;
  const isSyntheticUserId =
    !rawUserId ||
    rawUserId === "system" ||
    rawUserId === "webhook" ||
    rawUserId === "cron";
  const userIdForFk = isSyntheticUserId ? null : rawUserId ?? null;

  if (ctxActor) {
    return {
      actorType: ctxActor.type as ActorType,
      actorUserId: userIdForFk,
      actorLabel: ctxActor.label ?? null,
      actorSublabel: ctxActor.sublabel ?? null,
      actorRef: ctxActor.ref ?? null,
    };
  }

  if (userIdForFk) {
    return {
      actorType: "HUMAN" as ActorType,
      actorUserId: userIdForFk,
      actorLabel: null,
      actorSublabel: null,
      actorRef: null,
    };
  }

  return {
    actorType: "SYSTEM" as ActorType,
    actorUserId: null,
    actorLabel: "Sistema",
    actorSublabel: null,
    actorRef: null,
  };
}

/**
 * Anexa a origem de automacao (`automationId` + numero do card) ao `meta`
 * do evento quando a escrita acontece dentro de um passo de automacao.
 *
 * Chave `automationOrigin` — lida pela timeline/feed para renderizar
 * "via automação «X» · card #N". Nao sobrescreve um `automationOrigin`
 * que o caller tenha passado explicitamente. Eventos gravados fora de
 * automacao (acao manual, cron, webhook) seguem sem a chave, e a UI
 * degrada omitindo a linha.
 */
export function withAutomationOriginMeta(
  meta: Record<string, unknown> | undefined,
): Prisma.InputJsonValue {
  const base = meta ?? {};
  const origin = getAutomationOrigin();
  if (!origin || base.automationOrigin !== undefined) {
    return base as Prisma.InputJsonValue;
  }
  return { ...base, automationOrigin: origin } as Prisma.InputJsonValue;
}

/// Helper principal. Fire-and-forget (retorna Promise mas catch interno
/// evita propagar falhas para o caller). Use `await` se quiser garantir
/// ordem com outras escritas — em geral, deixe sem await.
export async function logEvent(input: LogEventInput): Promise<void> {
  if (shouldSkipActivityLog()) return;
  try {
    const actor = resolveActor(input);
    const metaJson = withAutomationOriginMeta(input.meta);

    await prisma.activityEvent.create({
      data: withOrgFromCtx({
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        entityLabel: input.entityLabel ?? null,
        dealId: input.dealId ?? null,
        contactId: input.contactId ?? null,
        conversationId: input.conversationId ?? null,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId,
        actorLabel: actor.actorLabel,
        actorSublabel: actor.actorSublabel,
        actorRef: actor.actorRef,
        field: input.field ?? null,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
        meta: metaJson,
      }),
    });
    await mirrorConversationChatEvent({
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      conversationId: input.conversationId,
      oldValue: input.oldValue,
      newValue: input.newValue,
      meta: input.meta,
      actor: {
        type: actor.actorType,
        label: actor.actorLabel,
      },
      actorUserId: actor.actorUserId,
    });
  } catch (err) {
    // ATENCAO: logEvent jamais deve derrubar a request principal.
    // Falhas de FK / org context ausente / DB indisponivel sao
    // logadas mas suprimidas.
    console.warn("[activity-log] logEvent failed:", {
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Atalho para registrar uma falha de envio de mensagem no Activity Log.
 *
 * Centraliza o `type: "MESSAGE_FAILED"` para que todas as origens (webhook
 * de status da Meta, envio imediato via API e Baileys) gerem o mesmo evento
 * — assim aparece no feed `/logs` e nas estatisticas. Fire-and-forget.
 *
 * O texto do erro vai em `newValue` (renderizado no feed) e em `meta.error`
 * (consumido por tooltips/detalhes). `source` distingue a origem da falha.
 */
export async function logMessageFailed(input: {
  messageId: string;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  /// Nome do contato/destinatario — usado como label da Origem no feed.
  contactLabel?: string | null;
  contactSublabel?: string | null;
  error?: string | null;
  /// Origem da falha: "meta" (webhook), "api" (envio imediato) ou "baileys".
  source?: "meta" | "api" | "baileys" | string;
  errorCode?: string | number | null;
  channel?: string | null;
}): Promise<void> {
  const errorText = input.error?.trim() || "Falha no envio";
  // Sem override de ator: deixamos `logEvent` derivar do contexto —
  // agente (HUMAN) no envio imediato via API, SYSTEM no webhook/worker.
  // O contato (destinatario) vai por `contactId`/`entityLabel` e é
  // resolvido como "Origem" (Cliente) no feed.
  await logEvent({
    type: "MESSAGE_FAILED",
    entityType: "MESSAGE",
    entityId: input.messageId,
    entityLabel: input.contactLabel ?? "Falha no envio",
    conversationId: input.conversationId ?? null,
    contactId: input.contactId ?? null,
    dealId: input.dealId ?? null,
    newValue: errorText,
    meta: {
      error: errorText,
      source: input.source ?? null,
      errorCode: input.errorCode ?? null,
      channel: input.channel ?? "WhatsApp",
      contactName: input.contactLabel ?? null,
      contactPhone: input.contactSublabel ?? null,
    },
  });
}

/**
 * Atalho para registrar leitura (ack `read` da Meta/WhatsApp) no Activity Log.
 *
 * Alimenta `/logs`, timeline do negócio e estatísticas futuras (taxa de
 * leitura). Só deve ser chamado na transição para `read` (não em reentrega).
 * Fire-and-forget.
 */
export async function logMessageRead(input: {
  messageId: string;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  contactLabel?: string | null;
  contactSublabel?: string | null;
  preview?: string | null;
  channel?: string | null;
  source?: "meta" | "baileys" | string;
}): Promise<void> {
  const preview = input.preview?.trim() || null;
  await logEvent({
    type: "MESSAGE_READ",
    entityType: "MESSAGE",
    entityId: input.messageId,
    entityLabel: input.contactLabel ?? "Mensagem lida",
    conversationId: input.conversationId ?? null,
    contactId: input.contactId ?? null,
    dealId: input.dealId ?? null,
    newValue: preview,
    actor: {
      type: "SYSTEM",
      label: "WhatsApp",
      sublabel: "confirmação de leitura",
      ref: null,
    },
    meta: {
      preview,
      source: input.source ?? "meta",
      channel: input.channel ?? "WhatsApp",
      contactName: input.contactLabel ?? null,
      contactPhone: input.contactSublabel ?? null,
    },
  });
}

/// Atalho usado pelo backfill / wrapper de `createDealEvent`. Recebe
/// o objeto serializado direto e nao deriva ator do contexto.
export async function logEventRaw(
  data: Prisma.ActivityEventUncheckedCreateInput,
): Promise<void> {
  if (shouldSkipActivityLog()) return;
  try {
    await prisma.activityEvent.create({ data });
  } catch (err) {
    console.warn("[activity-log] logEventRaw failed:", {
      type: data.type,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
