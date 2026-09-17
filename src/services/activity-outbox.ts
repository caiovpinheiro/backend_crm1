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
import { Prisma } from "@prisma/client";
import { type ScopedTx } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull } from "@/lib/request-context";
import { runLogEvent, type LogEventInput } from "@/services/activity-log";

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
