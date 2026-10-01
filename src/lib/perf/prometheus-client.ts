import { getLogger } from "@/lib/logger";

const log = getLogger("perf.prometheus-client");

/**
 * Cliente minimo da HTTP API do Prometheus (query e query_range).
 *
 * Config via env:
 *   PROMETHEUS_URL   — base do servidor (ex: http://prometheus:9090).
 *   PROMETHEUS_TOKEN — bearer opcional (se protegido por reverse proxy).
 *
 * Uso:
 *   const v = await promInstant('avg by (env) (rate(crm_http_requests_total[5m]))');
 *   // v = [{ metric: { env: 'prod' }, value: 12.3 }, ...]
 *
 * Nao introduzimos dependencia nova — usamos `fetch` (Node 22 embutido).
 * Erros: retorna array vazio e loga; o caller decide como sinalizar
 * "sem dados" no relatorio (schema versionado do perf-report).
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export type PromSample = {
  metric: Record<string, string>;
  value: number;
  timestamp: number;
};

export type PromRangeSeries = {
  metric: Record<string, string>;
  values: Array<{ t: number; v: number }>;
};

function baseUrl(): string | null {
  const url = process.env.PROMETHEUS_URL?.trim();
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  const token = process.env.PROMETHEUS_TOKEN?.trim();
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Instant query. Retorna array vazio em erro/indisponibilidade.
 */
export async function promInstant(
  query: string,
  opts?: { at?: Date; timeoutMs?: number },
): Promise<PromSample[]> {
  const base = baseUrl();
  if (!base) return [];
  const url = new URL(`${base}/api/v1/query`);
  url.searchParams.set("query", query);
  if (opts?.at) url.searchParams.set("time", String(Math.floor(opts.at.getTime() / 1000)));

  try {
    const res = await withTimeout(
      fetch(url, { headers: headers() }),
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      status: string;
      data?: { resultType: string; result: Array<{ metric: Record<string, string>; value: [number, string] }> };
    };
    if (json.status !== "success" || !json.data) return [];
    return json.data.result.map((r) => ({
      metric: r.metric,
      value: Number(r.value[1]) || 0,
      timestamp: Number(r.value[0]) || 0,
    }));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "[prom] instant query failed");
    return [];
  }
}

/**
 * Range query. Retorna series com pontos [{t,v}]. `stepSec` default 60s.
 */
export async function promRange(
  query: string,
  opts: { from: Date; to: Date; stepSec?: number; timeoutMs?: number },
): Promise<PromRangeSeries[]> {
  const base = baseUrl();
  if (!base) return [];
  const url = new URL(`${base}/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("start", String(Math.floor(opts.from.getTime() / 1000)));
  url.searchParams.set("end", String(Math.floor(opts.to.getTime() / 1000)));
  url.searchParams.set("step", String(opts.stepSec ?? 60));

  try {
    const res = await withTimeout(
      fetch(url, { headers: headers() }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      status: string;
      data?: { resultType: string; result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
    };
    if (json.status !== "success" || !json.data) return [];
    return json.data.result.map((r) => ({
      metric: r.metric,
      values: r.values.map(([t, v]) => ({ t, v: Number(v) || 0 })),
    }));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "[prom] range query failed");
    return [];
  }
}

/**
 * Helper: pega o maximo (pico) de uma range query.
 */
export function seriesMax(series: PromRangeSeries[]): number {
  let max = 0;
  for (const s of series) for (const p of s.values) if (p.v > max) max = p.v;
  return max;
}

/**
 * Helper: pega o valor atual (ultima amostra) por rotulo `env`.
 */
export function byEnv(samples: PromSample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) {
    const env = s.metric.env ?? "unknown";
    out[env] = s.value;
  }
  return out;
}

export function isPromConfigured(): boolean {
  return baseUrl() !== null;
}
