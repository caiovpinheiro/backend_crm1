/**
 * Revogação de sessões (SV-1): incrementa `users.sessionVersion` e avisa
 * quem precisa saber. Todo JWT emitido antes — inclusive o da própria
 * requisição que pediu — passa a ser rejeitado com 401; o cliente deve ir
 * para o login.
 *
 * Quando incrementar:
 *   - troca de senha (perfil, reset administrativo, "esqueci a senha");
 *   - "sair de todos os dispositivos" (`POST /api/me/sessions/revoke-all`);
 *   - desativação/erase do usuário e remoção da organização.
 *
 * Duas formas de uso:
 *   1. `revokeUserSessions(...)` — faz o `update` com `increment` e o pós.
 *   2. `SESSION_VERSION_BUMP` no `data` do seu próprio `update` (mesma
 *      transação da troca de senha / do erase) + `notifySessionsRevoked`
 *      depois do commit. Evita uma segunda escrita e o estado "senha
 *      trocada, mas sessões antigas ainda valem" se o bump falhasse.
 *
 * O pós (`notifySessionsRevoked`) é best-effort e nunca lança: invalida
 * os caches deste processo (versão + refresh do JWT), fecha os streams
 * SSE do usuário em todas as réplicas (`sseBus.revokeUser`) e audita.
 * Nas outras réplicas o token antigo cai em ≤ 60 s pelo TTL do cache.
 */
import { logAuditAsync } from "@/lib/audit/log";
import { invalidateJwtRefreshCache } from "@/lib/auth/jwt-refresh-cache";
import { invalidateSessionVersionCache } from "@/lib/auth/session-version";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import { sseBus } from "@/lib/sse-bus";

const log = getLogger("auth");

export type SessionRevocationReason =
  | "password_change"
  | "password_reset"
  | "revoke_all"
  | "user_erased"
  | "user_deleted";

export type SessionRevocationArgs = {
  userId: string;
  organizationId: string | null;
  reason: SessionRevocationReason;
  /** Quem pediu (default: o próprio usuário). */
  actorId?: string | null;
};

/** Fragmento para o `data` de um `user.update` que já vai acontecer. */
export const SESSION_VERSION_BUMP = { sessionVersion: { increment: 1 } } as const;

/**
 * Pós-incremento. Chame DEPOIS de o `update` (ou a transação) ter
 * confirmado. Síncrono e sem exceção: nada aqui pode falhar a request.
 */
export function notifySessionsRevoked(args: SessionRevocationArgs): void {
  invalidateSessionVersionCache(args.userId);
  invalidateJwtRefreshCache(args.userId);
  try {
    sseBus.revokeUser({ userId: args.userId, organizationId: args.organizationId });
  } catch (err) {
    log.warn({ err, userId: args.userId }, "[auth] revokeUser no SSE falhou");
  }
  log.info(
    { userId: args.userId, organizationId: args.organizationId, reason: args.reason },
    "[auth] sessões revogadas (sessionVersion incrementado)",
  );
  logAuditAsync({
    entity: "user",
    action: "sessions_revoked",
    entityId: args.userId,
    organizationId: args.organizationId,
    actorId: args.actorId ?? args.userId,
    metadata: { reason: args.reason },
  });
}

/**
 * Incrementa e notifica. Devolve a versão nova. Propaga erro do banco (o
 * chamador decide o status) — exceto linha inexistente (usuário já
 * apagado): aí só notifica, porque o token cai por "linha não encontrada".
 */
export async function revokeUserSessions(args: SessionRevocationArgs): Promise<number | null> {
  let version: number | null = null;
  try {
    const row = await prismaBase.user.update({
      where: { id: args.userId },
      data: SESSION_VERSION_BUMP,
      select: { sessionVersion: true },
    });
    version = typeof row?.sessionVersion === "number" ? row.sessionVersion : null;
  } catch (err) {
    if (!isRecordNotFound(err)) throw err;
  }
  notifySessionsRevoked(args);
  return version;
}

function isRecordNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2025"
  );
}
