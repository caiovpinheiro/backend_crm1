/**
 * Resposta em tempo uniforme para as rotas públicas de autenticação
 * (tenant-lookup, forgot-password, resend-verification).
 *
 * O corpo já era genérico, mas o TEMPO entregava se o e-mail existia
 * (pentest out/2026: ~190 ms inexistente × ~580 ms existente no
 * forgot-password). Duas peças:
 *
 *  1. o trabalho que só acontece para conta existente (token, e-mail) sai
 *     do caminho da resposta — ver `runInBackground`;
 *  2. piso de latência: a resposta nunca sai antes de `AUTH_MIN_RESPONSE_MS`
 *     contados da entrada no handler, o que cobre a diferença residual de
 *     uma consulta que acha × não acha linha.
 */

export const DEFAULT_AUTH_MIN_RESPONSE_MS = 300;
const MAX_AUTH_MIN_RESPONSE_MS = 5_000;

/** `AUTH_MIN_RESPONSE_MS` (ms). `0` desliga; inválido cai no default. */
export function getAuthMinResponseMs(): number {
  const raw = process.env.AUTH_MIN_RESPONSE_MS?.trim();
  if (!raw) return DEFAULT_AUTH_MIN_RESPONSE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTH_MIN_RESPONSE_MS;
  return Math.min(Math.floor(n), MAX_AUTH_MIN_RESPONSE_MS);
}

/**
 * Espera o que falta para completar o piso desde `startedAtMs`
 * (`Date.now()` capturado na primeira linha do handler).
 */
export async function waitForMinResponseTime(
  startedAtMs: number,
  floorMs: number = getAuthMinResponseMs(),
): Promise<void> {
  const remaining = floorMs - (Date.now() - startedAtMs);
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}
