/**
 * Activity Log central (Kommo-grade) — log de atividade unificado.
 *
 * Caracteristicas:
 *   - Fire-and-forget: nunca derruba a request principal (feed informativo).
 *   - Outbox transacional: eventos que alimentam rollups sao inseridos em
 *     `activity_outbox` dentro da mesma transacao da mutacao e projetados
 *     por um worker dedicado. Ver `src/services/activity-outbox.ts`.
 *   - Org-scoped: `organizationId` explícito ou herdado do RequestContext.
 *   - actorType obrigatório no input: sem fallback silencioso para SYSTEM.
 *   - Dimensões normalizadas (pipeline, stage, tabulation, department,
 *     channel, source) promovidas a colunas para rollups.
 *
 * NOTA sobre mensagens:
 *   Rollups de MESSAGE_SENT/MESSAGE_RECEIVED (volume, tempo, heatmap,
 *   connections, attendants) leem da tabela `Message`, que ja e a fonte
 *   operacional transacional. Os eventos `MESSAGE_SENT`/`MESSAGE_RECEIVED`
 *   aqui servem para timeline/auditoria e permanecem fire-and-forget.
 */

import { Prisma, type ActorType, type EventEntityType } from "@prisma/client";
import { PrismaClient } from "@prisma/client";

import { getAutomationOrigin } from "@/lib/automation-origin";
import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import {
  getActorContext,
  getRequestContext,
  type ContextActor,
} from "@/lib/request-context";
import { mirrorConversationChatEvent } from "@/services/conversation-event-mirror";

function shouldSkipActivityLog(): boolean {
  const v = process.env.IMPORT_SKIP_ACTIVITY_LOG;
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export type LogEventInput = {
  type: string;

  // ── Sujeito ────────────────────────────────────────────────────
  entityType: EventEntityType;
  entityId: string;
  entityLabel?: string | null;

  dealId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;

  // ── Dimensões normalizadas (snapshot no momento do evento) ─────
  pipelineId?: string | null;
  fromStageId?: string | null;
  toStageId?: string | null;
  tabulationId?: string | null;
  departmentId?: string | null;
  channel?: string | null;
  /// Snapshot real da origem no momento do evento. Backfill marca
  /// sourceIsReconstructed=true.
  source?: string | null;

  // ── Conteudo ───────────────────────────────────────────────────
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  meta?: Record<string, unknown>;

  // ── Ator ─────────────────────────────────────────────────────────
  /// Obrigatório. Call site deve informar HUMAN, AI, AUTOMATION,
  /// INTEGRATION ou SYSTEM explicitamente.
  actorType: ActorType;
  actorUserId?: string | null;
  actorLabel?: string | null;
  actorSublabel?: string | null;
  actorRef?: string | null;
  /// Override rico de ator (type/label/sublabel/ref). Quando presente,
  /// complementa actorType sem substituir o tipo.
  actor?: ContextActor;
  /// Usuário humano que deu origem a uma execução automatizada. Distinto
  /// de actorUserId — preserva a atribuição do disparador para rollups
  /// de produtividade. Ex.: botão "Executar automação" ou gatilho
  /// disparado por uma ação humana.
  triggeredByUserId?: string | null;

  /// Org explícita — use quando o caller está fora de `withOrgContext`
  /// ou o ALS pode já ter sido encerrado.
  organizationId?: string | null;

  /// Chave de idempotência. Quando presente, o projector da outbox usa
  /// ON CONFLICT para evitar duplicar a linha em activity_events em caso
  /// de reprocessamento. Eventos fire-and-forget deixam null.
  idempotencyKey?: string | null;
};

export function userIdForFk(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "system" || trimmed === "webhook" || trimmed === "cron") {
    return null;
  }
  return trimmed;
}

function resolveActor(input: LogEventInput): {
  actorType: ActorType;
  actorUserId: string | null;
  triggeredByUserId: string | null;
  actorLabel: string | null;
  actorSublabel: string | null;
  actorRef: string | null;
} {
  const ctx = getRequestContext();
  const ctxActor = input.actor ?? getActorContext();

  const safeUserId =
    input.actorType === "HUMAN"
      ? userIdForFk(input.actorUserId ?? ctx?.userId)
      : userIdForFk(input.actorUserId);
  const safeTriggeredByUserId = userIdForFk(
    input.triggeredByUserId ?? ctx?.triggeredByUserId,
  );

  return {
    actorType: input.actorType,
    actorUserId: safeUserId,
    triggeredByUserId: safeTriggeredByUserId,
    actorLabel: ctxActor?.label ?? input.actorLabel ?? null,
    actorSublabel: ctxActor?.sublabel ?? input.actorSublabel ?? null,
    actorRef: ctxActor?.ref ?? input.actorRef ?? null,
  };
}

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

function deriveDimensions(
  input: LogEventInput,
  meta: Record<string, unknown>,
): Pick<
  Prisma.ActivityEventUncheckedCreateInput,
  | "pipelineId"
  | "fromStageId"
  | "toStageId"
  | "tabulationId"
  | "departmentId"
  | "channel"
  | "source"
  | "sourceIsReconstructed"
> {
  return {
    pipelineId:
      input.pipelineId ??
      (typeof meta.pipelineId === "string" ? meta.pipelineId : null) ??
      (typeof meta.to === "object" &&
      meta.to !== null &&
      typeof (meta.to as Record<string, unknown>).pipelineId === "string"
        ? ((meta.to as Record<string, unknown>).pipelineId as string)
        : null) ??
      (input.type === "STAGE_CHANGED" &&
      typeof meta.from === "object" &&
      meta.from !== null &&
      typeof (meta.from as Record<string, unknown>).pipelineId === "string"
        ? ((meta.from as Record<string, unknown>).pipelineId as string)
        : null),
    fromStageId:
      input.fromStageId ??
      (typeof meta.fromStageId === "string" ? meta.fromStageId : null) ??
      (typeof meta.from === "object" &&
      meta.from !== null &&
      typeof (meta.from as Record<string, unknown>).id === "string"
        ? ((meta.from as Record<string, unknown>).id as string)
        : null),
    toStageId:
      input.toStageId ??
      (typeof meta.toStageId === "string" ? meta.toStageId : null) ??
      (typeof meta.to === "object" &&
      meta.to !== null &&
      typeof (meta.to as Record<string, unknown>).id === "string"
        ? ((meta.to as Record<string, unknown>).id as string)
        : null) ??
      (typeof meta.stageId === "string" ? meta.stageId : null),
    tabulationId:
      input.tabulationId ??
      (typeof meta.tabulationId === "string" ? meta.tabulationId : null),
    departmentId:
      input.departmentId ??
      (typeof meta.departmentId === "string" ? meta.departmentId : null) ??
      (typeof meta.tabulationDepartmentId === "string"
        ? meta.tabulationDepartmentId
        : null),
    channel:
      input.channel ?? (typeof meta.channel === "string" ? meta.channel : null),
    source:
      input.source ?? (typeof meta.source === "string" ? meta.source : null),
    sourceIsReconstructed: input.source ? false : undefined,
  };
}

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export async function runLogEvent(
  prismaLike: PrismaLike,
  input: LogEventInput,
): Promise<void> {
  const actor = resolveActor(input);
  const meta = input.meta ?? {};
  const metaJson = withAutomationOriginMeta(meta);
  const orgId =
    input.organizationId ?? getRequestContext()?.organizationId ?? null;
  if (!orgId) {
    throw new Error(
      "[logEvent] RequestContext sem organizationId. " +
        "Envolva o handler em withOrgContext ou passe organizationId.",
    );
  }

  const dims = deriveDimensions(input, meta);

  const data = withOrg(
    {
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      dealId: input.dealId ?? null,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      pipelineId: dims.pipelineId,
      fromStageId: dims.fromStageId,
      toStageId: dims.toStageId,
      tabulationId: dims.tabulationId,
      departmentId: dims.departmentId,
      channel: dims.channel,
      source: dims.source,
      sourceIsReconstructed: dims.source ?? false ? false : undefined,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      triggeredByUserId: actor.triggeredByUserId,
      actorLabel: actor.actorLabel,
      actorSublabel: actor.actorSublabel,
      actorRef: actor.actorRef,
      field: input.field ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      meta: metaJson,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    orgId,
  );

  try {
    await prismaLike.activityEvent.create({ data });
  } catch (err) {
    // Reprocessamento idempotente: se a chave já existe, o evento já foi
    // projetado. Outras violações de unicidade/falhas continuam propagando.
    const target = err instanceof Prisma.PrismaClientKnownRequestError
      ? (err.meta?.target ?? "")
      : "";
    const targetText = Array.isArray(target) ? target.join(" ") : String(target);
    if (
      input.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      targetText.includes("activity_events_org_idempotency_idx")
    ) {
      return;
    }
    throw err;
  }
}

export async function logEvent(input: LogEventInput): Promise<void> {
  if (shouldSkipActivityLog()) return;
  try {
    const actor = resolveActor(input);
    await runLogEvent(prisma as unknown as PrismaClient, input);
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
    console.warn("[activity-log] logEvent failed:", {
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function logMessageFailed(input: {
  messageId: string;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  contactLabel?: string | null;
  contactSublabel?: string | null;
  error?: string | null;
  source?: "meta" | "api" | "baileys" | string;
  errorCode?: string | number | null;
  channel?: string | null;
  actorType?: ActorType;
  actorUserId?: string | null;
}): Promise<void> {
  const errorText = input.error?.trim() || "Falha no envio";
  await logEvent({
    type: "MESSAGE_FAILED",
    entityType: "MESSAGE",
    entityId: input.messageId,
    entityLabel: input.contactLabel ?? "Falha no envio",
    conversationId: input.conversationId ?? null,
    contactId: input.contactId ?? null,
    dealId: input.dealId ?? null,
    channel: input.channel ?? "WhatsApp",
    actorType: input.actorType ?? "SYSTEM",
    actorUserId: input.actorUserId ?? null,
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
    channel: input.channel ?? "WhatsApp",
    actorType: "SYSTEM",
    actorLabel: "WhatsApp",
    actorSublabel: "confirmação de leitura",
    newValue: preview,
    meta: {
      preview,
      source: input.source ?? "meta",
      channel: input.channel ?? "WhatsApp",
      contactName: input.contactLabel ?? null,
      contactPhone: input.contactSublabel ?? null,
    },
  });
}

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
