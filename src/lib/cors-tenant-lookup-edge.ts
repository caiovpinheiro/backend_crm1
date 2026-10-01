/**
 * Lado Edge (middleware) da consulta de origem de tenant do CORS.
 *
 * O middleware roda no Edge Runtime e não alcança Prisma nem Redis. A
 * decisão vem de uma rota Node interna (`/api/internal/cors-origin`) do
 * próprio processo, chamada em loopback, e fica numa memória curta por
 * processo — o caminho quente (toda chamada do browser a `/api/*`) NÃO
 * consulta nada:
 *
 *  - confiável: 60 s (suspender a org leva até ~2 min para valer aqui,
 *    somando o cache da rota);
 *  - não confiável: 10 s (org nova fica confiável logo após verificar o
 *    e-mail; a rota interna invalida o cache dela na hora);
 *  - erro (rota fora, timeout): origem negada, nova tentativa em 3 s.
 *
 * Chamadas simultâneas do mesmo slug compartilham uma consulta só.
 *
 * A rota interna exige o header `x-crm-internal-key`, derivado do
 * `AUTH_SECRET` (HMAC) — sem segredo configurado não há consulta e toda
 * origem de tenant é negada. Só puro Web API aqui (sem imports Node).
 */
import type { TenantOriginLookup } from "@/lib/browser-api-cors";

export const CORS_LOOKUP_PATH = "/api/internal/cors-origin";
export const CORS_LOOKUP_KEY_HEADER = "x-crm-internal-key";

const KEY_CONTEXT = "crm:cors-tenant-origin-lookup:v1";

const TRUSTED_TTL_MS = 60_000;
const UNTRUSTED_TTL_MS = 10_000;
const ERROR_TTL_MS = 3_000;
const LOOKUP_TIMEOUT_MS = 2_000;
const MAX_ENTRIES = 2_000;

type Entry = { trusted: boolean; expiresAt: number };

const memory = new Map<string, Entry>();
const inFlight = new Map<string, Promise<boolean>>();
let keyMemo: { secret: string; key: string } | null = null;
let lastFailureLogAt = 0;

/** No máximo um aviso por minuto: sem a consulta, origem de tenant fica sem CORS. */
function warnLookupFailure(reason: string): void {
  const now = Date.now();
  if (now - lastFailureLogAt < 60_000) return;
  lastFailureLogAt = now;
  // eslint-disable-next-line no-console -- módulo do middleware (runtime Edge); o logger (pino + AsyncLocalStorage) não pode entrar aqui
  console.error(
    `[cors-tenant-lookup] consulta interna falhou (${reason}); origens de tenant ficam sem CORS até voltar. Confira PORT/CORS_LOOKUP_BASE_URL e AUTH_SECRET.`,
  );
}

function authSecret(): string {
  return (process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "").trim();
}

function toHex(buf: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Chave do header interno; `null` sem `AUTH_SECRET`. Mesma conta nos dois lados. */
export async function deriveCorsLookupKey(): Promise<string | null> {
  const secret = authSecret();
  if (!secret) return null;
  if (keyMemo && keyMemo.secret === secret) return keyMemo.key;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const key = toHex(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(KEY_CONTEXT)));
  keyMemo = { secret, key };
  return key;
}

/**
 * Base do loopback. Não usa `req.nextUrl.origin`: atrás do proxy ele é o
 * host público e a consulta sairia pela internet. `CORS_LOOKUP_BASE_URL`
 * cobre topologias em que o processo não escuta em 127.0.0.1:$PORT.
 */
function lookupBaseUrl(): string {
  const explicit = (process.env.CORS_LOOKUP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const port = (process.env.PORT ?? "").trim() || "3000";
  return `http://127.0.0.1:${port}`;
}

function remember(slug: string, trusted: boolean, ttlMs: number): void {
  if (!memory.has(slug) && memory.size >= MAX_ENTRIES) memory.clear();
  memory.set(slug, { trusted, expiresAt: Date.now() + ttlMs });
}

async function fetchTrusted(slug: string): Promise<boolean> {
  try {
    const key = await deriveCorsLookupKey();
    if (!key) {
      warnLookupFailure("AUTH_SECRET ausente");
      remember(slug, false, ERROR_TTL_MS);
      return false;
    }
    const res = await fetch(
      `${lookupBaseUrl()}${CORS_LOOKUP_PATH}?slug=${encodeURIComponent(slug)}`,
      {
        method: "GET",
        headers: { [CORS_LOOKUP_KEY_HEADER]: key, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      warnLookupFailure(`HTTP ${res.status}`);
      remember(slug, false, ERROR_TTL_MS);
      return false;
    }
    const body = (await res.json()) as { trusted?: unknown };
    const trusted = body.trusted === true;
    remember(slug, trusted, trusted ? TRUSTED_TTL_MS : UNTRUSTED_TTL_MS);
    return trusted;
  } catch (err) {
    warnLookupFailure(err instanceof Error ? err.name : "erro");
    remember(slug, false, ERROR_TTL_MS);
    return false;
  }
}

export const lookupTenantOriginFromEdge: TenantOriginLookup = (slug) => {
  const hit = memory.get(slug);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.trusted);

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const p = fetchTrusted(slug).finally(() => {
    inFlight.delete(slug);
  });
  inFlight.set(slug, p);
  return p;
};

export function resetCorsTenantLookupForTests(): void {
  memory.clear();
  inFlight.clear();
  keyMemo = null;
  lastFailureLogAt = 0;
}
