/**
 * Parada graciosa da API Next (`APP_MODE=api` / `api-public`) — B6 / N-INF-3.
 *
 * Sem isto, no SIGTERM o `start-server` do Next fechava o listener e esperava
 * as requisições terminarem — mas um stream SSE nunca termina: o processo
 * ficava preso até o SIGKILL, o Redis guardava as entradas do teto de SSE
 * (contagem dobrada por até 35 s → 429 pós-deploy) e todos os navegadores
 * reconectavam juntos.
 *
 * Fluxo no SIGTERM/SIGINT (o entrypoint exporta NEXT_MANUAL_SIG_HANDLE=true
 * para o Next não registrar o handler dele):
 *   1. `draining` → `/api/health` responde 503 e o SSE recusa conexão nova
 *      (503 + Retry-After).
 *   2. Streams SSE abertos recebem `retry:` com jitter e são fechados (cada
 *      um libera a vaga no Redis).
 *   3. Espera `API_SHUTDOWN_PRESTOP_MS` (default 5 s) servindo normalmente,
 *      para o proxy tirar a réplica do balanceamento.
 *   4. Fecha o listener HTTP e espera as requisições em curso.
 *   5. Ganchos (`registerApiShutdownHook`, ex.: `$disconnect` do Prisma), sai 0.
 * Teto total `API_SHUTDOWN_TIMEOUT_MS` (default 25 s): passou, derruba as
 * conexões restantes e sai 1 — antes do SIGKILL (stop_grace_period ≥ 35 s).
 *
 * Este módulo é importado por `instrumentation.ts`, que também é empacotado
 * para o runtime Edge: nada de pg/ioredis/prisma/logger aqui. Estado em
 * `globalThis` porque instrumentation e rotas viram bundles diferentes.
 */

/** Fecha um stream SSE com o `retry:` dado. Pode devolver a liberação da vaga. */
export type SseShutdownCloser = (retryMs: number) => unknown;

export type ApiShutdownHook = { name: string; run: () => unknown };

type ShutdownState = {
  draining: boolean;
  seq: number;
  streams: Map<number, SseShutdownCloser>;
  hooks: ApiShutdownHook[];
  installed: boolean;
};

const g = globalThis as unknown as { __crmApiShutdown?: ShutdownState };

function state(): ShutdownState {
  if (!g.__crmApiShutdown) {
    g.__crmApiShutdown = {
      draining: false,
      seq: 0,
      streams: new Map(),
      hooks: [],
      installed: false,
    };
  }
  return g.__crmApiShutdown;
}

/** `true` depois do SIGTERM: health 503, SSE novo recusado. */
export function isApiDraining(): boolean {
  return state().draining;
}

/** Registra um stream SSE aberto. Devolve a função que o remove (teardown). */
export function registerSseStream(close: SseShutdownCloser): () => void {
  const s = state();
  const id = ++s.seq;
  s.streams.set(id, close);
  return () => {
    s.streams.delete(id);
  };
}

/** Passo extra no fim do shutdown (depois do listener fechado). */
export function registerApiShutdownHook(hook: ApiShutdownHook): void {
  const s = state();
  if (s.hooks.some((h) => h.name === hook.name)) return;
  s.hooks.push(hook);
}

export const DEFAULT_API_SHUTDOWN_TIMEOUT_MS = 25_000;
export const DEFAULT_API_SHUTDOWN_PRESTOP_MS = 5_000;
/** Faixa do `retry:` enviado aos streams SSE no shutdown (espalha a reconexão). */
export const SSE_SHUTDOWN_RETRY_MIN_MS = 2_000;
export const SSE_SHUTDOWN_RETRY_MAX_MS = 15_000;

export function sseShutdownRetryMs(random: () => number = Math.random): number {
  const span = SSE_SHUTDOWN_RETRY_MAX_MS - SSE_SHUTDOWN_RETRY_MIN_MS;
  return SSE_SHUTDOWN_RETRY_MIN_MS + Math.floor(Math.max(0, Math.min(1, random())) * span);
}

/** `Retry-After` (s) para SSE recusado durante o shutdown. */
export function sseShutdownRetryAfterSec(random: () => number = Math.random): number {
  return Math.ceil(sseShutdownRetryMs(random) / 1000);
}

type HttpServerLike = {
  close: (cb?: (err?: Error) => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
  listening?: boolean;
};

function isHttpServer(h: unknown): h is HttpServerLike {
  if (!h || typeof h !== "object") return false;
  const s = h as HttpServerLike;
  return (
    typeof s.close === "function" &&
    typeof s.closeIdleConnections === "function" &&
    typeof s.closeAllConnections === "function" &&
    s.listening === true
  );
}

/**
 * Servidores HTTP escutando neste processo. O `start-server` do Next não
 * expõe o dele; `_getActiveHandles` é a única via sem patch no Next.
 */
export function findListeningHttpServers(): HttpServerLike[] {
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
  try {
    return (proc._getActiveHandles?.() ?? []).filter(isHttpServer);
  } catch {
    return [];
  }
}

type ShutdownLog = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
};

export type ApiShutdownOptions = {
  log: ShutdownLog;
  timeoutMs?: number;
  preStopMs?: number;
  /** Injetáveis para teste. */
  getServers?: () => HttpServerLike[];
  exit?: (code: number) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function readMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : fallback;
}

/** Lê `API_SHUTDOWN_TIMEOUT_MS` e `API_SHUTDOWN_PRESTOP_MS`. */
export function apiShutdownTimingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): { timeoutMs: number; preStopMs: number } {
  const timeoutMs = readMs(env.API_SHUTDOWN_TIMEOUT_MS, DEFAULT_API_SHUTDOWN_TIMEOUT_MS);
  const preStopMs = Math.min(
    readMs(env.API_SHUTDOWN_PRESTOP_MS, DEFAULT_API_SHUTDOWN_PRESTOP_MS),
    Math.max(0, timeoutMs - 1_000),
  );
  return { timeoutMs, preStopMs };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Monta a função de shutdown (não registra sinal). */
export function createApiShutdown(opts: ApiShutdownOptions): (signal: string) => Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_SHUTDOWN_TIMEOUT_MS;
  const preStopMs = opts.preStopMs ?? DEFAULT_API_SHUTDOWN_PRESTOP_MS;
  const getServers = opts.getServers ?? findListeningHttpServers;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  let running: Promise<void> | null = null;

  return (signal: string) => {
    if (running) {
      opts.log.info("[api-shutdown] já em andamento — sinal ignorado", { signal });
      return running;
    }
    running = (async () => {
      const s = state();
      s.draining = true;
      const servers = getServers();
      opts.log.info("[api-shutdown] sinal recebido — drenando", {
        signal,
        timeoutMs,
        preStopMs,
        sseStreams: s.streams.size,
        httpServers: servers.length,
      });

      let exited = false;
      let safety: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number) => {
        if (exited) return;
        exited = true;
        if (safety) clearTimeout(safety);
        exit(code);
      };
      safety = setTimeout(() => {
        if (exited) return;
        opts.log.error("[api-shutdown] passou do teto — derrubando conexões e saindo", {
          timeoutMs,
        });
        for (const srv of servers) {
          try {
            srv.closeAllConnections?.();
          } catch {
            /* ignore */
          }
        }
        finish(1);
      }, timeoutMs);
      safety.unref?.();

      // 2. SSE: retry com jitter e fecha. Cada closer libera a vaga no Redis.
      const closers = [...s.streams.values()];
      s.streams.clear();
      await Promise.allSettled(
        closers.map(async (close) => {
          await close(sseShutdownRetryMs(random));
        }),
      );
      if (closers.length > 0) {
        opts.log.info("[api-shutdown] streams SSE fechados", { count: closers.length });
      }

      // 3. Pré-parada: segue servindo enquanto o proxy vê o 503 do health.
      if (preStopMs > 0) await sleep(preStopMs);
      if (exited) return;

      // 4. Listener fechado; espera as requisições em curso.
      if (servers.length === 0) {
        opts.log.warn("[api-shutdown] nenhum servidor HTTP encontrado — saindo sem esperar requisições");
      }
      await Promise.all(
        servers.map(
          (srv) =>
            new Promise<void>((resolve) => {
              try {
                srv.close(() => resolve());
                srv.closeIdleConnections?.();
              } catch {
                resolve();
              }
            }),
        ),
      );
      if (exited) return;

      // 5. Ganchos (Prisma etc.).
      for (const hook of s.hooks) {
        if (exited) return;
        try {
          await hook.run();
        } catch (err) {
          opts.log.warn("[api-shutdown] gancho falhou", { hook: hook.name, err: errMessage(err) });
        }
      }
      if (exited) return;
      opts.log.info("[api-shutdown] encerrado");
      finish(0);
    })();
    return running;
  };
}

/** Registra SIGTERM/SIGINT uma vez por processo. */
export function installApiGracefulShutdown(
  opts: ApiShutdownOptions,
  proc: Pick<NodeJS.Process, "on"> = process,
): ((signal: string) => Promise<void>) | null {
  const s = state();
  if (s.installed) return null;
  s.installed = true;
  const shutdown = createApiShutdown(opts);
  proc.on("SIGTERM", () => void shutdown("SIGTERM"));
  proc.on("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}

/** Só para teste: zera o estado global. */
export function __resetApiShutdownStateForTest(): void {
  delete g.__crmApiShutdown;
}
