/**
 * Cadência e limites da BATIDA de presença (`POST /api/presence/beat`) —
 * parte pura (só env), importável por `entity-presence.ts`,
 * `system-presence.ts` e pelas rotas sem ciclo de import.
 *
 * - `PRESENCE_BEAT_INTERVAL_MS` (padrão 60.000; 15.000–300.000): cadência
 *   recomendada ao cliente, devolvida em `nextBeatMs`.
 * - `PRESENCE_BEAT_MIN_INTERVAL_MS` (padrão 30.000; 1.000–intervalo): no
 *   máximo 1 batida ACEITA (que escreve) por usuário nesse intervalo,
 *   somando abas, navegadores e as rotas antigas (`/api/agents/me/ping`,
 *   `/api/presence/heartbeat`).
 * - `PRESENCE_BEAT_NOOP_WINDOW_MS` (padrão 45.000; 0 desliga; teto 0,75 ×
 *   intervalo): batida do mesmo usuário com a MESMA lista de entidades da
 *   última batida GRAVADA há menos disso → 204 sem escrita (ping antigo: com
 *   qualquer batida gravada; heartbeat antigo: com a entidade na lista).
 * - TTL/filtro dos viewers ("quem está vendo") = 2,5 × intervalo (150 s com
 *   60 s): tolera uma batida perdida/atrasada (aba em segundo plano com
 *   timers estrangulados) sem o avatar sumir e voltar. Derivado, sem env
 *   própria.
 * - "CRM aberto" (`system_usage_sessions`): offline depois de
 *   max(300 s, 5 × intervalo) sem batida gravada.
 */

export const PRESENCE_BEAT_INTERVAL_MS_DEFAULT = 60_000;
export const PRESENCE_BEAT_INTERVAL_MS_MIN = 15_000;
export const PRESENCE_BEAT_INTERVAL_MS_MAX = 300_000;

export const PRESENCE_BEAT_MIN_INTERVAL_MS_DEFAULT = 30_000;
const MIN_INTERVAL_FLOOR_MS = 1_000;

export const PRESENCE_BEAT_NOOP_WINDOW_MS_DEFAULT = 45_000;
/** Janela do no-op ≤ este fator × intervalo (a cadência normal nunca vira no-op). */
const NOOP_WINDOW_MAX_FACTOR = 0.75;

/** TTL do viewer = este fator × intervalo da batida. */
export const PRESENCE_VIEWER_TTL_FACTOR = 2.5;

/** Piso do "CRM aberto" (comportamento anterior: 300 s). */
const SYSTEM_STALE_FLOOR_MS = 300_000;
const SYSTEM_STALE_FACTOR = 5;

type Env = Record<string, string | undefined>;

function intFromEnv(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** `PRESENCE_BEAT_INTERVAL_MS` limitado a 15–300 s. Padrão 60 s. */
export function presenceBeatIntervalMs(env: Env = process.env): number {
  const n = intFromEnv(env.PRESENCE_BEAT_INTERVAL_MS);
  if (n === null || n <= 0) return PRESENCE_BEAT_INTERVAL_MS_DEFAULT;
  return Math.min(PRESENCE_BEAT_INTERVAL_MS_MAX, Math.max(PRESENCE_BEAT_INTERVAL_MS_MIN, n));
}

/**
 * `PRESENCE_BEAT_MIN_INTERVAL_MS` limitado a 1 s–intervalo da batida (o
 * limite nunca pode ser maior que a cadência recomendada, senão toda batida
 * de um cliente comportado seria descartada). Padrão 30 s.
 */
export function presenceBeatMinIntervalMs(env: Env = process.env): number {
  const interval = presenceBeatIntervalMs(env);
  const n = intFromEnv(env.PRESENCE_BEAT_MIN_INTERVAL_MS);
  const wanted = n === null || n <= 0 ? PRESENCE_BEAT_MIN_INTERVAL_MS_DEFAULT : n;
  return Math.min(interval, Math.max(MIN_INTERVAL_FLOOR_MS, wanted));
}

/**
 * `PRESENCE_BEAT_NOOP_WINDOW_MS`: janela (desde a última batida GRAVADA do
 * usuário) em que a mesma lista vira 204 sem escrita. Padrão 45 s; `0`
 * desliga; limitada a 0,75 × intervalo (45 s com 60 s), para a batida de
 * cadência normal de um navegador sozinho sempre gravar.
 */
export function presenceBeatNoopWindowMs(env: Env = process.env): number {
  const n = intFromEnv(env.PRESENCE_BEAT_NOOP_WINDOW_MS);
  if (n !== null && n <= 0) return 0;
  const wanted = n === null ? PRESENCE_BEAT_NOOP_WINDOW_MS_DEFAULT : n;
  return Math.min(Math.floor(NOOP_WINDOW_MAX_FACTOR * presenceBeatIntervalMs(env)), wanted);
}

/** TTL/filtro dos viewers: 2,5 × intervalo (150 s com o padrão). */
export function presenceViewerTtlMs(env: Env = process.env): number {
  return Math.round(PRESENCE_VIEWER_TTL_FACTOR * presenceBeatIntervalMs(env));
}

/** "CRM aberto" vence depois de max(300 s, 5 × intervalo) sem batida gravada. */
export function systemPresenceStaleMs(env: Env = process.env): number {
  return Math.max(SYSTEM_STALE_FLOOR_MS, SYSTEM_STALE_FACTOR * presenceBeatIntervalMs(env));
}
