import { prismaBase } from "@/lib/prisma-base";

/**
 * Lock-out exponencial pra brute-force protection (PR 4.1).
 *
 * Politica:
 *   1.  N <= 4 tentativas falhas: nao bloqueia (margem pra usuario errar).
 *   2.  5-9 falhas: lockout exponencial:
 *         5 falhas → 1 min
 *         6 falhas → 2 min
 *         7 falhas → 4 min
 *         8 falhas → 8 min
 *         9 falhas → 16 min
 *   3.  >=10 falhas em 24h: 24h hard-lock (admin precisa resetar).
 *
 * Janela de contagem: 15 minutos rolling (default). Tentativa
 * bem-sucedida ZERA implicitamente — porque o `outcome=success`
 * conta diferente. Mas pra simplicidade contamos "falhas nas ultimas
 * 15min" e ignoramos sucessos no meio.
 *
 * Pra resetar manualmente (admin):
 *   DELETE FROM login_attempts WHERE email = X AND outcome != 'success';
 *
 * @see docs/mfa-totp.md
 */

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const HARD_LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const HARD_LOCK_THRESHOLD = 10;
const SOFT_LOCK_START_AT = 5;

/**
 * Outcomes que CONTAM como falha pra fins de lockout.
 * `mfa_required` NAO conta — usuario passou pela senha; so falta o
 * segundo fator (que tem rate-limit proprio na rota MFA).
 * `locked` NAO conta — e a tentativa ja bloqueada, nao uma falha nova
 * de credencial. Contar `locked` fazia o hard-lock de 24h se
 * auto-renovar a cada retry do usuario, e nem o reset de senha do
 * admin destravava (o admin nao limpa login_attempts).
 */
const FAILURE_OUTCOMES = new Set([
  "bad_password",
  "bad_mfa",
  "no_user",
]);

export type LoginOutcome =
  | "success"
  | "mfa_required"
  | "bad_password"
  | "bad_mfa"
  | "no_user"
  | "locked"
  | "db_error";

export interface LockoutDecision {
  /** Se true, bloqueia a tentativa SEM nem checar credencial. */
  locked: boolean;
  /** Quanto tempo ate poder tentar de novo (em segundos). 0 se nao locked. */
  retryAfterSec: number;
  /** Tentativas falhas na janela atual (debug/UX). */
  recentFailures: number;
  /** Se o user esta em hard-lock 24h. */
  hardLocked: boolean;
}

function softLockDelayMs(failures: number): number {
  // 5 → 1min ; 6 → 2min ; ... cresce 2x ate 16min (na 9a falha).
  const idx = failures - SOFT_LOCK_START_AT;
  const minutes = Math.pow(2, idx);
  return minutes * 60 * 1000;
}

/**
 * Decide se o login deve ser bloqueado para `email`. Chame ANTES de
 * verificar a senha — economiza CPU em ataque distribuido.
 */
export async function checkLockout(email: string): Promise<LockoutDecision> {
  const now = new Date();

  // Hard lock 24h
  const sinceHard = new Date(now.getTime() - HARD_LOCK_WINDOW_MS);
  let hardCount: number;
  try {
    hardCount = await prismaBase.loginAttempt.count({
      where: {
        email,
        outcome: { in: Array.from(FAILURE_OUTCOMES) },
        createdAt: { gt: sinceHard },
      },
    });
  } catch {
    // DB caiu — fail-open pra nao trancar todo mundo. Logged em outro lado.
    return {
      locked: false,
      retryAfterSec: 0,
      recentFailures: 0,
      hardLocked: false,
    };
  }

  if (hardCount >= HARD_LOCK_THRESHOLD) {
    return {
      locked: true,
      retryAfterSec: Math.ceil(HARD_LOCK_WINDOW_MS / 1000),
      recentFailures: hardCount,
      hardLocked: true,
    };
  }

  // Soft lock baseado em janela curta (15min)
  const sinceSoft = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
  const recent = await prismaBase.loginAttempt.findMany({
    where: {
      email,
      outcome: { in: Array.from(FAILURE_OUTCOMES) },
      createdAt: { gt: sinceSoft },
    },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  if (recent.length < SOFT_LOCK_START_AT) {
    return {
      locked: false,
      retryAfterSec: 0,
      recentFailures: recent.length,
      hardLocked: false,
    };
  }

  const lastFailureAt = recent[0].createdAt.getTime();
  const delayMs = softLockDelayMs(recent.length);
  const releasesAt = lastFailureAt + delayMs;
  const remainingMs = releasesAt - now.getTime();

  if (remainingMs > 0) {
    return {
      locked: true,
      retryAfterSec: Math.ceil(remainingMs / 1000),
      recentFailures: recent.length,
      hardLocked: false,
    };
  }

  return {
    locked: false,
    retryAfterSec: 0,
    recentFailures: recent.length,
    hardLocked: false,
  };
}

export interface RecordAttemptInput {
  email: string;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  outcome: LoginOutcome;
}

/**
 * Persiste a tentativa de login. Chame SEMPRE no final do authorize(),
 * tanto em sucesso quanto falha. Em sucesso, podemos opcionalmente
 * limpar tentativas anteriores (ver `clearFailuresOnSuccess`).
 *
 * Erros sao engolidos (DB caiu = log e segue) — bloquear login porque
 * o audit log falhou e pior que nao registrar a tentativa.
 */
export async function recordLoginAttempt(
  input: RecordAttemptInput,
): Promise<void> {
  try {
    await prismaBase.loginAttempt.create({
      data: {
        email: input.email,
        userId: input.userId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        outcome: input.outcome,
      },
    });
  } catch (err) {
    console.error("[auth/lockout] recordLoginAttempt failed", err);
  }
}

/**
 * Limpa tentativas falhas apos login bem-sucedido. Idempotente.
 * Usar com criterio: se um atacante adivinhar a senha 1x, isso reseta
 * o lockout — mas se ele adivinhou a senha, ja era. Compromisso UX.
 */
export async function clearFailuresOnSuccess(email: string): Promise<void> {
  try {
    await prismaBase.loginAttempt.deleteMany({
      where: {
        email,
        outcome: { in: Array.from(FAILURE_OUTCOMES) },
        createdAt: { gt: new Date(Date.now() - LOCKOUT_WINDOW_MS) },
      },
    });
  } catch (err) {
    console.error("[auth/lockout] clearFailuresOnSuccess failed", err);
  }
}

/**
 * Desbloqueio administrativo: remove TODAS as falhas do email (janela
 * soft de 15min E hard de 24h), sem esperar um login bem-sucedido —
 * que e impossivel enquanto o hard-lock estiver ativo, ja que o
 * checkLockout roda antes da checagem de senha.
 *
 * Chamado quando um admin reseta a senha do usuario
 * (PATCH /api/users/[id]). Sem isso, trocar a senha nao destravava a
 * conta: as falhas antigas seguiam na janela de 24h.
 */
export async function clearLoginLockout(email: string): Promise<void> {
  try {
    await prismaBase.loginAttempt.deleteMany({
      where: {
        email,
        outcome: { in: Array.from(FAILURE_OUTCOMES) },
      },
    });
  } catch (err) {
    console.error("[auth/lockout] clearLoginLockout failed", err);
  }
}
