/**
 * O que fazer quando a sessão Baileys cai. Puro (sem socket, sem banco):
 * `baileys-session.ts` chama a cada `connection: "close"`.
 *
 * Regra geral: reconecta para sempre, com espera dobrando até 5 min e
 * variação aleatória. Só para de tentar quando o WhatsApp diz que a
 * autenticação acabou — aí precisa de QR de novo:
 * - 401 loggedOut: o aparelho foi desvinculado no celular → apaga as
 *   credenciais (como antes).
 * - 403 forbidden / 411 multideviceMismatch: a conta não aceita mais esta
 *   sessão → pede QR, sem apagar nada.
 * - 500 badSession 3× seguidas: sessão corrompida → pede QR.
 * 515 restartRequired (normal logo após ler o QR) reconecta na hora.
 * 440 connectionReplaced: outra conexão abriu a mesma sessão; quem decide
 * se volta é a trava (`session-lock.ts`) — aqui só espera um pouco mais.
 */

export const RECONNECT_BASE_DELAY_MS = 2_000;
export const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
export const BAD_SESSION_MAX_STREAK = 3;
/** Espera mínima depois de "conexão substituída", para não brigar com o outro lado. */
export const CONNECTION_REPLACED_DELAY_MS = 15_000;

const REASON_NAMES: Record<number, string> = {
  401: "loggedOut",
  403: "forbidden",
  408: "connectionLost",
  411: "multideviceMismatch",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  503: "unavailableService",
  515: "restartRequired",
};

export function disconnectReasonName(statusCode: number | undefined): string {
  if (statusCode === undefined) return "unknown";
  return REASON_NAMES[statusCode] ?? `code_${statusCode}`;
}

export type ReconnectDecision =
  | { action: "retry"; delayMs: number; reason: string }
  | { action: "logout"; reason: string }
  | { action: "needs_qr"; reason: string };

/** Espera da tentativa `attempt` (1, 2, 3…): 2 s, 4 s, 8 s… até 5 min, ±25%. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(RECONNECT_MAX_DELAY_MS, exp);
  const jitter = 0.75 + random() * 0.5;
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(capped * jitter));
}

export function decideReconnect(input: {
  statusCode: number | undefined;
  /** Tentativa que vai acontecer agora (1 = primeira desde a última conexão aberta). */
  attempt: number;
  /** Quantos badSession seguidos, contando este. */
  badSessionStreak: number;
  random?: () => number;
}): ReconnectDecision {
  const reason = disconnectReasonName(input.statusCode);
  switch (input.statusCode) {
    case 401:
      return { action: "logout", reason };
    case 403:
    case 411:
      return { action: "needs_qr", reason };
    case 500:
      if (input.badSessionStreak >= BAD_SESSION_MAX_STREAK) {
        return { action: "needs_qr", reason };
      }
      break;
    case 515:
      return { action: "retry", delayMs: 0, reason };
    case 440:
      return {
        action: "retry",
        delayMs: Math.max(CONNECTION_REPLACED_DELAY_MS, backoffDelayMs(input.attempt, input.random)),
        reason,
      };
    default:
      break;
  }
  return { action: "retry", delayMs: backoffDelayMs(input.attempt, input.random), reason };
}
