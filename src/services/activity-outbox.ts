/**
 * Outbox transacional do Activity Log.
 *
 * Eventos que alimentam rollups/dashboard sao inseridos na outbox dentro da
 * mesma transacao Prisma da mutacao de negocio. Um worker poll consome a
 * outbox e projeta em activity_events. Em caso de falha, aplica backoff
 * exponencial e, apos o limite de tentativas, move para dead letter.
 *
 * Eventos puramente informativos do feed continuam usando logEvent() com
 * semantica fire-and-forget.
 */

import { randomUUID } from "node:crypto";

import { metrics } from "@/lib/metrics";
import { Prisma, type ActorType } from "@prisma/client";
import { type ScopedTx } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull } from "@/lib/request-context";
import {
  runLogEvent,
  userIdForFk,
  type LogEventInput,
} from "@/services/activity-log";

export type ActivityOutboxInput = LogEventInput & {
  /**
   * Chave de idempotencia para a outbox. Deve ser deterministica dada a
   * mutacao de negocio (ex.: `${dealId}:stage_changed:${newStageId}`).
   * Se omitida, gera uma chave a partir dos campos do evento — suficiente
   * quando a transacao nao pode re-criar a mesma entidade com mesmo id.
   */
  idempotencyKey?: string;
};

const MAX_ATTEMPTS = 5;
// 10s, 40s, 2min, 8min, 30min
const BACKOFF_MS = [10_000, 40_000, 120_000, 480_000, 1_800_000];
const CLEANUP_DAYS = 7;

type PrismaTx = ScopedTx;

function fallbackIdempotencyKey(input: ActivityOutboxInput): string {
  return [
    input.organizationId ?? getOrgIdOrNull() ?? "no-org",
    input.type,
    input.entityType,
    input.entityId,
    input.dealId ?? "",
    input.contactId ?? "",
    input.conversationId ?? "",
    input.field ?? "",
  ].join(":");
}

export async function insertActivityOutbox(
  tx: PrismaTx,
  input: ActivityOutboxInput,
): Promise<void> {
  const orgId = input.organizationId ?? getOrgIdOrNull();
  if (!orgId) {
    throw new Error(
      "[insertActivityOutbox] organizationId ausente. Passe explicitamente ou envolva em withOrgContext.",
    );
  }

  const idempotencyKey =
    input.idempotencyKey ?? fallbackIdempotencyKey(input);

  // ON CONFLICT permite reprocessamentos seguros: a mesma chave de
  // idempotência gerada dentro de uma transação que retryou não quebra
  // o commit e nem duplica o evento quando o worker projetar.
  await tx.$executeRaw`
    INSERT INTO "activity_outbox" ("id", "organizationId", "idempotencyKey", "payload", "maxAttempts", "scheduledFor")
    VALUES (
      ${randomUUID()},
      ${orgId},
      ${idempotencyKey},
      ${JSON.stringify(input)}::jsonb,
      ${MAX_ATTEMPTS},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("organizationId", "idempotencyKey") DO NOTHING
  `;
}

type OutboxRow = {
  id: string;
  organizationId: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

export async function pollAndProjectActivityOutbox(
  batchSize = 100,
): Promise<{ processed: number; dead: number; failed: number }> {
  const rows = await prismaBase.$queryRaw<OutboxRow[]>`
    SELECT id, "organizationId", payload, attempts, "maxAttempts"
    FROM "activity_outbox"
    WHERE "processedAt" IS NULL
      AND "deadLetterAt" IS NULL
      AND "scheduledFor" <= CURRENT_TIMESTAMP
    ORDER BY "organizationId", "scheduledFor", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT ${batchSize}
  `;

  let processed = 0;
  let dead = 0;
  let failed = 0;

  for (const row of rows) {
    const payload = row.payload as LogEventInput;
    payload.organizationId = row.organizationId;

    try {
      await prismaBase.$transaction(async (tx) => {
        if (payload.idempotencyKey) {
          const existing = await tx.activityEvent.findFirst({
            where: {
              organizationId: row.organizationId,
              idempotencyKey: payload.idempotencyKey,
            },
            select: { id: true },
          });
          if (existing) {
            await tx.activityOutbox.update({
              where: { id: row.id },
              data: { processedAt: new Date() },
            });
            return;
          }
        }
        await runLogEvent(tx, payload);
        await tx.activityOutbox.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
      });
      processed++;
      metrics.activityOutbox.processed.inc(
        { organization: row.organizationId, status: "ok" },
        1,
      );
    } catch (err) {
      failed++;
      const errorText = err instanceof Error ? err.message : String(err);
      const nextAttempt = row.attempts + 1;
      if (nextAttempt >= row.maxAttempts) {
        await prismaBase.activityOutbox.update({
          where: { id: row.id },
          data: {
            deadLetterAt: new Date(),
            lastError: errorText.slice(0, 500),
            attempts: nextAttempt,
          },
        });
        dead++;
        metrics.activityOutbox.processed.inc(
          { organization: row.organizationId, status: "dead_letter" },
          1,
        );
        console.error(
          `[activity-outbox] DEAD LETTER id=${row.id} org=${row.organizationId} attempts=${nextAttempt}`,
          { error: errorText },
        );
      } else {
        const backoff =
          BACKOFF_MS[Math.min(nextAttempt, BACKOFF_MS.length) - 1] ??
          BACKOFF_MS[BACKOFF_MS.length - 1];
        await prismaBase.activityOutbox.update({
          where: { id: row.id },
          data: {
            scheduledFor: new Date(Date.now() + backoff),
            lastError: errorText.slice(0, 500),
            attempts: nextAttempt,
          },
        });
        metrics.activityOutbox.processed.inc(
          { organization: row.organizationId, status: "retry" },
          1,
        );
      }
    }
  }

  return { processed, dead, failed };
}

export async function cleanupActivityOutbox(days = CLEANUP_DAYS): Promise<number> {
  const result = await prismaBase.$executeRaw`
    DELETE FROM "activity_outbox"
    WHERE "processedAt" IS NOT NULL
      AND "processedAt" < CURRENT_TIMESTAMP - (${days} || ' days')::interval
  `;
  return Number(result ?? 0);
}

export async function runActivityOutboxOnce(
  batchSize = 100,
): Promise<{ processed: number; dead: number; failed: number; remaining: number }> {
  const result = await pollAndProjectActivityOutbox(batchSize);
  const remaining = await prismaBase.activityOutbox.count({
    where: { processedAt: null, deadLetterAt: null },
  });
  return { ...result, remaining };
}

/**
 * Loop do worker de outbox. Deve ser executado em processo dedicado
 * (ex.: worker-activity-outbox). Para Next.js runtime, prefira chamadas
 * explicitas em cron/health-check ou worker BullMQ.
 */
export async function startActivityOutboxWorker(
  intervalMs = 5_000,
  batchSize = 100,
): Promise<() => void> {
  let stopped = false;
  let handle: NodeJS.Timeout | null = null;

  const tick = async () => {
    try {
      await pollAndProjectActivityOutbox(batchSize);
    } catch (err) {
      console.error("[activity-outbox] tick failed", err);
    }
    if (!stopped) {
      handle = setTimeout(tick, intervalMs);
    }
  };

  handle = setTimeout(tick, 0);

  return () => {
    stopped = true;
    if (handle) clearTimeout(handle);
  };
}

const ACTOR_TYPES = new Set([
  "HUMAN",
  "AI",
  "AUTOMATION",
  "INTEGRATION",
  "SYSTEM",
]);

type TabulationOutboxPayload = LogEventInput & {
  departmentId?: string | null;
};

type TabulationOutboxClaim = {
  id: string;
  organizationId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  attempts: number;
  maxAttempts: number;
};

function asPayload(value: Prisma.JsonValue): TabulationOutboxPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as TabulationOutboxPayload;
  if (payload.type !== "CONVERSATION_TABULATED") return null;
  if (!payload.entityType || !payload.entityId) return null;
  return payload;
}

function metaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function postponeOutboxRow(
  id: string,
  attempts: number,
  maxAttempts: number,
  errorText: string,
): Promise<void> {
  const nextAttempt = attempts + 1;
  const lastError = errorText.slice(0, 500);
  if (nextAttempt >= maxAttempts) {
    await prismaBase.activityOutbox.update({
      where: { id },
      data: { deadLetterAt: new Date(), lastError, attempts: nextAttempt },
    });
    return;
  }
  const backoff =
    BACKOFF_MS[Math.min(nextAttempt, BACKOFF_MS.length) - 1] ??
    BACKOFF_MS[BACKOFF_MS.length - 1];
  await prismaBase.activityOutbox.update({
    where: { id },
    data: {
      scheduledFor: new Date(Date.now() + backoff),
      lastError,
      attempts: nextAttempt,
    },
  });
}

async function actorUserIdFromDealClose(
  tx: Prisma.TransactionClient,
  row: { organizationId: string; createdAt: Date },
  conversationId: string,
): Promise<string | null> {
  const from = new Date(row.createdAt.getTime() - 2 * 60_000);
  const to = new Date(row.createdAt.getTime() + 5 * 60_000);
  const found = await tx.dealEvent.findFirst({
    where: {
      organizationId: row.organizationId,
      type: "CONVERSATION_CLOSED",
      userId: { not: null },
      createdAt: { gte: from, lte: to },
      meta: { path: ["conversationId"], equals: conversationId },
    },
    orderBy: { createdAt: "desc" },
    select: { userId: true },
  });
  return userIdForFk(found?.userId);
}

async function actorUserIdNearClose(
  tx: Prisma.TransactionClient,
  row: { organizationId: string; createdAt: Date },
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null;
  const from = new Date(row.createdAt.getTime() - 2 * 60_000);
  const to = new Date(row.createdAt.getTime() + 2 * 60_000);
  const found = await tx.activityEvent.findFirst({
    where: {
      organizationId: row.organizationId,
      conversationId,
      type: "ASSIGNEE_CHANGED",
      actorUserId: { not: null },
      occurredAt: { gte: from, lte: to },
    },
    orderBy: { occurredAt: "desc" },
    select: { actorUserId: true },
  });
  return userIdForFk(found?.actorUserId);
}

/**
 * Copia só `CONVERSATION_TABULATED` da outbox para `activity_events`.
 * Não espelha no chat e não projeta os outros tipos da fila.
 * `occurredAt` fica o `createdAt` da outbox, para o período do dashboard.
 */
export async function projectTabulationOutboxBatch(
  batchSize = 40,
): Promise<number> {
  const candidates = await prismaBase.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM "activity_outbox"
    WHERE "processedAt" IS NULL
      AND "deadLetterAt" IS NULL
      AND "scheduledFor" <= CURRENT_TIMESTAMP
      AND payload->>'type' = 'CONVERSATION_TABULATED'
    ORDER BY "scheduledFor", id
    LIMIT ${batchSize}
  `;

  let projected = 0;
  for (const candidate of candidates) {
    try {
      const wrote = await prismaBase.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<TabulationOutboxClaim[]>`
          SELECT id, "organizationId", payload, "createdAt", attempts, "maxAttempts"
          FROM "activity_outbox"
          WHERE id = ${candidate.id}
            AND "processedAt" IS NULL
            AND "deadLetterAt" IS NULL
          FOR UPDATE SKIP LOCKED
        `;
        const row = locked[0];
        if (!row) return null;

        const payload = asPayload(row.payload);
        if (!payload) {
          await tx.activityOutbox.update({
            where: { id: row.id },
            data: {
              deadLetterAt: new Date(),
              lastError: "payload de tabulação inválido",
              attempts: row.attempts + 1,
            },
          });
          return null;
        }

        if (payload.idempotencyKey) {
          const existing = await tx.activityEvent.findFirst({
            where: {
              organizationId: row.organizationId,
              idempotencyKey: payload.idempotencyKey,
            },
            select: { id: true },
          });
          if (existing) {
            await tx.activityOutbox.update({
              where: { id: row.id },
              data: { processedAt: new Date() },
            });
            return null;
          }
        }

        const meta =
          payload.meta && typeof payload.meta === "object"
            ? payload.meta
            : {};
        const actorFromPayload = userIdForFk(payload.actorUserId);
        const actorUserId =
          actorFromPayload ??
          (payload.conversationId
            ? await actorUserIdFromDealClose(
                tx,
                row,
                payload.conversationId,
              )
            : null) ??
          (await actorUserIdNearClose(tx, row, payload.conversationId));
        const rawActor = payload.actorType ?? "HUMAN";
        const actorType: ActorType = ACTOR_TYPES.has(rawActor)
          ? (rawActor as ActorType)
          : "HUMAN";
        const label =
          typeof payload.actor?.label === "string" ? payload.actor.label : null;

        await tx.activityEvent.create({
          data: {
            organizationId: row.organizationId,
            occurredAt: row.createdAt,
            type: "CONVERSATION_TABULATED",
            entityType: payload.entityType,
            entityId: payload.entityId,
            entityLabel: payload.entityLabel ?? null,
            dealId: payload.dealId ?? null,
            contactId: payload.contactId ?? null,
            conversationId: payload.conversationId ?? null,
            departmentId:
              payload.departmentId ?? metaString(meta, "departmentId"),
            tabulationId: metaString(meta, "tabulationId"),
            actorType,
            actorUserId,
            actorLabel: label,
            field: payload.field ?? null,
            oldValue: payload.oldValue ?? null,
            newValue: payload.newValue ?? null,
            meta: meta as Prisma.InputJsonValue,
            ...(payload.idempotencyKey
              ? { idempotencyKey: payload.idempotencyKey }
              : {}),
          },
        });
        await tx.activityOutbox.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
        return row.organizationId;
      });
      if (wrote) {
        projected++;
        metrics.activityOutbox.processed.inc(
          { organization: wrote, status: "ok" },
          1,
        );
      }
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        await prismaBase.activityOutbox.update({
          where: { id: candidate.id },
          data: { processedAt: new Date() },
        });
        continue;
      }
      const current = await prismaBase.activityOutbox.findUnique({
        where: { id: candidate.id },
        select: { attempts: true, maxAttempts: true, processedAt: true },
      });
      if (!current || current.processedAt) continue;
      const errorText = err instanceof Error ? err.message : String(err);
      await postponeOutboxRow(
        candidate.id,
        current.attempts,
        current.maxAttempts,
        errorText,
      );
    }
  }

  return projected;
}

let tabulationProjectorStarted = false;

/** Timer à parte. Não consome fila de WhatsApp, campanha ou automação. */
export function startTabulationOutboxProjector(intervalMs = 5_000): void {
  if (tabulationProjectorStarted) return;
  tabulationProjectorStarted = true;

  const tick = () => {
    void projectTabulationOutboxBatch()
      .catch((err) => {
        console.error("[activity-outbox] tabulation tick failed", err);
      })
      .finally(() => {
        setTimeout(tick, intervalMs);
      });
  };

  setTimeout(tick, 0);
}
