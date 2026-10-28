/**
 * Webchat v2 — idempotência da entrada servidor a servidor
 * (docs/decisoes/webchat-widget.md §9.6, tabela `webchat_ingress_keys`).
 *
 * `(channelId, idempotencyKey)` é unique. A chave vale 24 h:
 *  - mesma chave + mesmo corpo (sha256) já concluída → o mesmo 200
 *    (`Idempotent-Replayed: true`), sem refazer nada;
 *  - mesma chave + outro corpo → 409 `IDEMPOTENCY_KEY_REUSED`;
 *  - ainda processando → 409 `IDEMPOTENCY_IN_PROGRESS` (o site tenta de
 *    novo). Processamento que falhou (ou travou além de
 *    `STALE_PROCESSING_MS`) pode ser retomado com a mesma chave.
 *
 * Roda no contexto de org do canal (`inWebchatOrg`): `prisma` scoped.
 */
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { WEBCHAT_S2S_IDEMPOTENCY_TTL_HOURS } from "@/lib/webchat/v2-config";

const log = getLogger("webchat-s2s-idempotency");

export const WEBCHAT_S2S_IDEMPOTENCY_TTL_MS = WEBCHAT_S2S_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
/** "processing" mais velho que isto = processo morreu no meio: retomável. */
export const STALE_PROCESSING_MS = 2 * 60 * 1000;
/** Limpeza oportunista das chaves vencidas: no máximo uma por canal neste intervalo. */
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

export type S2SResponseBody = { conversation_id: string; url: string };

export type IdempotencyClaim =
  | { kind: "claimed"; id: string }
  | { kind: "replay"; response: S2SResponseBody }
  | { kind: "reused" }
  | { kind: "in_progress" };

export function hashS2SBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

function isUnique(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function readStoredResponse(v: unknown): S2SResponseBody | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return typeof r.conversation_id === "string" && typeof r.url === "string"
    ? { conversation_id: r.conversation_id, url: r.url }
    : null;
}

/**
 * Reserva a chave para este pedido (ou diz o que fazer com ela).
 * `now` só para testes.
 */
export async function claimIdempotencyKey(input: {
  channelId: string;
  key: string;
  requestHash: string;
  now?: Date;
}): Promise<IdempotencyClaim> {
  const now = input.now ?? new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await prisma.webchatIngressKey.create({
        data: withOrgFromCtx({
          channelId: input.channelId,
          idempotencyKey: input.key,
          requestHash: input.requestHash,
          status: "processing",
          createdAt: now,
        }),
        select: { id: true },
      });
      return { kind: "claimed", id: row.id };
    } catch (err) {
      if (!isUnique(err)) throw err;
    }

    const existing = await prisma.webchatIngressKey.findFirst({
      where: { channelId: input.channelId, idempotencyKey: input.key },
      select: { id: true, requestHash: true, status: true, response: true, createdAt: true },
    });
    if (!existing) continue; // apagada no meio (limpeza): tenta criar de novo

    // Vencida (24 h): a chave volta a valer como nova.
    if (now.getTime() - existing.createdAt.getTime() > WEBCHAT_S2S_IDEMPOTENCY_TTL_MS) {
      await prisma.webchatIngressKey.deleteMany({ where: { id: existing.id, createdAt: existing.createdAt } });
      continue;
    }
    if (existing.requestHash !== input.requestHash) return { kind: "reused" };
    if (existing.status === "done") {
      const response = readStoredResponse(existing.response);
      if (response) return { kind: "replay", response };
    }
    const retomavel =
      existing.status === "failed" ||
      (existing.status === "processing" && now.getTime() - existing.createdAt.getTime() > STALE_PROCESSING_MS) ||
      existing.status === "done"; // "done" sem resposta legível: refaz
    if (!retomavel) return { kind: "in_progress" };
    const res = await prisma.webchatIngressKey.updateMany({
      where: { id: existing.id, status: existing.status, createdAt: existing.createdAt },
      data: { status: "processing", createdAt: now, response: Prisma.DbNull, completedAt: null },
    });
    if (res.count === 1) return { kind: "claimed", id: existing.id };
    return { kind: "in_progress" };
  }
  return { kind: "in_progress" };
}

export async function completeIdempotencyKey(id: string, response: S2SResponseBody): Promise<void> {
  await prisma.webchatIngressKey.update({
    where: { id },
    data: { status: "done", response: response as Prisma.InputJsonValue, completedAt: new Date() },
  });
}

/** Falhou: a mesma chave pode ser reenviada (não vira replay de erro). */
export async function failIdempotencyKey(id: string): Promise<void> {
  try {
    await prisma.webchatIngressKey.update({ where: { id }, data: { status: "failed", completedAt: new Date() } });
  } catch (err) {
    log.warn({ err }, "não marcou a chave de idempotência como falha");
  }
}

/** Apaga as chaves com mais de 24 h (todas as do canal/org do contexto). */
export async function purgeExpiredIngressKeys(channelId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBCHAT_S2S_IDEMPOTENCY_TTL_MS);
  const res = await prisma.webchatIngressKey.deleteMany({
    where: { channelId, createdAt: { lt: cutoff } },
  });
  return res.count;
}

const lastPurgeAt = new Map<string, number>();

/**
 * Retenção das chaves (§9.8 [C]) sem worker novo: a própria entrada limpa
 * o canal de vez em quando (no máximo a cada 10 min por processo). Chave
 * vencida que sobrar é tratada como nova em `claimIdempotencyKey`.
 */
export async function maybePurgeExpiredIngressKeys(channelId: string, nowMs: number = Date.now()): Promise<void> {
  const last = lastPurgeAt.get(channelId) ?? 0;
  if (nowMs - last < PURGE_INTERVAL_MS) return;
  lastPurgeAt.set(channelId, nowMs);
  if (lastPurgeAt.size > 10_000) lastPurgeAt.clear();
  try {
    await purgeExpiredIngressKeys(channelId, new Date(nowMs));
  } catch (err) {
    log.warn({ err, channelId }, "limpeza das chaves de idempotência falhou (não-fatal)");
  }
}

/** Só para testes. */
export function resetIngressPurgeClockForTests(): void {
  lastPurgeAt.clear();
}
