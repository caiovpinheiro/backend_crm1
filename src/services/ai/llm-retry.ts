/**
 * Timeout + retry da chamada ao LLM.
 *
 * Antes disso `generateWithTools` chamava o `generateText` sem timeout: um
 * request pendurado na OpenAI segurava o worker de IA indefinidamente (o job
 * do BullMQ não terminava e a conexão de pool ficava presa).
 *
 * Duas regras que valem mais que a implementação:
 *
 *  1. O retry vive AQUI, na camada de chamada ao modelo — antes de qualquer
 *     envio ao cliente. O runner só recebe o texto final, então retentar
 *     nunca duplica mensagem no WhatsApp.
 *  2. Só erro transitório é retentado (timeout, 429, 5xx, rede). 401/403
 *     (chave inválida) e erro de validação NÃO são retentados: a segunda
 *     tentativa falha igual, só queima tempo e dinheiro. Na dúvida, NÃO
 *     retenta — o default de `isTransientLlmError` é `false`.
 *
 * A falha final sobe como exceção e o `runner.ts` já a registra em
 * `AIAgentRun` (status FAILED + errorMessage).
 */

import { getLogger } from "@/lib/logger";

const log = getLogger("ai-llm");

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** Timeout por tentativa. `AI_LLM_TIMEOUT_MS`, default 60s. */
export function llmTimeoutMs(): number {
  return envInt("AI_LLM_TIMEOUT_MS", 60_000);
}

/**
 * Tentativas TOTAIS (1 = sem retry). `AI_LLM_MAX_ATTEMPTS`, default 3.
 * Com o backoff abaixo, o pior caso são ~3×60s + ~1,5s de espera.
 */
export function llmMaxAttempts(): number {
  return Math.min(envInt("AI_LLM_MAX_ATTEMPTS", 3), 5);
}

/** Base do backoff exponencial. `AI_LLM_RETRY_BASE_MS`, default 500ms. */
export function llmRetryBaseMs(): number {
  return envInt("AI_LLM_RETRY_BASE_MS", 500);
}

/** Estourou o timeout desta tentativa. Sempre transitório. */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    const limit =
      timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    super(`A chamada ao modelo passou de ${limit} e foi abortada.`);
    this.name = "LlmTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  responseHeaders?: unknown;
  cause?: unknown;
};

function asErrorLike(err: unknown): ErrorLike {
  return err && typeof err === "object" ? (err as ErrorLike) : {};
}

function httpStatus(err: ErrorLike): number | null {
  for (const v of [err.statusCode, err.status]) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

function textOf(err: ErrorLike): string {
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";
  const code = typeof err.code === "string" ? err.code : "";
  return `${name} ${code} ${message}`.toLowerCase();
}

// Erros de rede que valem retry. `ENOTFOUND` fica FORA de propósito: DNS que
// não resolve costuma ser baseURL/config errada, não blip de rede.
const TRANSIENT_NET_CODES = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "epipe",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "network error",
  "premature close",
];

// Nomes de erro do AI SDK / zod que significam "o input está errado".
// Retentar não muda nada.
const PERMANENT_NAMES = [
  "typevalidationerror",
  "invalidargumenterror",
  "invalidprompterror",
  "invalidresponsedataerror",
  "invalidtoolinputerror",
  "unsupportedfunctionalityerror",
  "nosuchtoolerror",
  "nosuchmodelerror",
  "nosuchproviderror",
  "zoderror",
];

function classify(err: ErrorLike, depth: number): boolean | null {
  const status = httpStatus(err);
  if (status !== null) {
    // 408 request timeout, 409 conflito de lock, 429 rate limit, 5xx.
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500) return true;
    // 400 (validação), 401/403 (chave), 404 (modelo), 422 — não retenta.
    if (status >= 400) return false;
  }

  const text = textOf(err);

  // Chave/permissão: NUNCA retenta, mesmo sem status na mão.
  if (
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("incorrect api key") ||
    text.includes("unauthorized") ||
    text.includes("insufficient_quota") ||
    text.includes("chave openai")
  ) {
    return false;
  }

  if (PERMANENT_NAMES.some((n) => text.includes(n))) return false;

  if (
    text.includes("llmtimeouterror") ||
    text.includes("aborterror") ||
    text.includes("timeouterror") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("aborted") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("overloaded") ||
    text.includes("service unavailable")
  ) {
    return true;
  }

  if (TRANSIENT_NET_CODES.some((c) => text.includes(c))) return true;

  // undici/fetch embrulham a causa real. Desce no máximo 2 níveis.
  if (depth < 2 && err.cause) {
    return classify(asErrorLike(err.cause), depth + 1);
  }

  return null;
}

/**
 * `true` só para erro que tem chance real de passar na próxima tentativa.
 * Default (inclusive erro desconhecido): `false`.
 */
export function isTransientLlmError(err: unknown): boolean {
  if (err instanceof LlmTimeoutError) return true;
  return classify(asErrorLike(err), 0) === true;
}

/**
 * `Retry-After` da resposta (429/503), em ms. Ignora valor absurdo — não
 * vale segurar o worker por minutos esperando a janela do rate limit.
 */
function retryAfterMs(err: unknown): number | null {
  const headers = asErrorLike(err).responseHeaders;
  if (!headers || typeof headers !== "object") return null;
  const raw = (headers as Record<string, unknown>)["retry-after"];
  const secs = typeof raw === "string" ? Number(raw) : raw;
  if (typeof secs !== "number" || !Number.isFinite(secs) || secs <= 0) {
    return null;
  }
  return Math.min(secs, 20) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff exponencial com jitter: ~500ms, ~1s, ~2s (+ até 50% de jitter). */
export function backoffMs(attempt: number, baseMs = llmRetryBaseMs()): number {
  const exp = baseMs * 2 ** (attempt - 1);
  return Math.round(exp * (1 + Math.random() * 0.5));
}

export type CallLlmOptions = {
  /** Só para log — ex.: `generateText gpt-4o-mini`. */
  label?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injetável nos testes pra não esperar de verdade. */
  sleepFn?: (ms: number) => Promise<void>;
};

/**
 * Roda `fn` com timeout por tentativa e retry só em erro transitório.
 *
 * O `AbortSignal` recebido DEVE ser repassado ao SDK (`abortSignal`), senão
 * o timeout só abandona a Promise e o socket continua aberto.
 */
export async function callLlmWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: CallLlmOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? llmTimeoutMs();
  const maxAttempts = Math.max(1, options.maxAttempts ?? llmMaxAttempts());
  const label = options.label ?? "llm";
  const nap = options.sleepFn ?? sleep;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let timedOut = false;
    controller.signal.addEventListener("abort", () => {
      timedOut = true;
    });

    try {
      return await fn(controller.signal);
    } catch (err) {
      // Abort nosso: o SDK devolve AbortError, que não diz "timeout".
      // Normaliza pra mensagem que vai parar no `AIAgentRun.errorMessage`.
      lastErr = timedOut ? new LlmTimeoutError(timeoutMs) : err;

      const transient = isTransientLlmError(lastErr);
      const last = attempt >= maxAttempts;

      if (!transient) {
        log.warn(
          `${label}: erro nao-transitorio na tentativa ${attempt} — sem retry`,
          { err: describe(lastErr) },
        );
        throw lastErr;
      }
      if (last) {
        log.warn(`${label}: falhou nas ${maxAttempts} tentativas`, {
          err: describe(lastErr),
        });
        throw lastErr;
      }

      const wait = retryAfterMs(lastErr) ?? backoffMs(attempt);
      log.warn(
        `${label}: erro transitorio na tentativa ${attempt}/${maxAttempts} — retry em ${wait}ms`,
        { err: describe(lastErr) },
      );
      await nap(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
