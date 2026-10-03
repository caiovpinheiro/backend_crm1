import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SSE_SHUTDOWN_RETRY_MAX_MS,
  SSE_SHUTDOWN_RETRY_MIN_MS,
  __resetApiShutdownStateForTest,
  apiShutdownTimingsFromEnv,
  createApiShutdown,
  installApiGracefulShutdown,
  isApiDraining,
  registerApiShutdownHook,
  registerSseStream,
  sseShutdownRetryAfterSec,
  sseShutdownRetryMs,
} from "./api-shutdown";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Servidor HTTP falso: `close` só chama o callback quando `finish()` rodar. */
function fakeServer() {
  let closeCb: (() => void) | null = null;
  const srv = {
    listening: true,
    close: vi.fn((cb?: () => void) => {
      closeCb = cb ?? null;
    }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
    finish: () => closeCb?.(),
  };
  return srv;
}

describe("api-shutdown", () => {
  beforeEach(() => {
    __resetApiShutdownStateForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetApiShutdownStateForTest();
  });

  it("drena: 503 no health, SSE com retry e jitter, espera o listener, ganchos e sai 0", async () => {
    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit:${code}`));
    const srv = fakeServer();
    const retries: number[] = [];
    registerSseStream(async (retryMs) => {
      retries.push(retryMs);
      order.push("sse");
    });
    const unregistered = vi.fn();
    const off = registerSseStream(unregistered);
    off(); // teardown normal antes do sinal: não é chamado
    registerApiShutdownHook({ name: "prisma", run: () => order.push("prisma") });

    const sleep = vi.fn(async (ms: number) => {
      order.push(`sleep:${ms}`);
      expect(isApiDraining()).toBe(true);
    });
    const shutdown = createApiShutdown({
      log: fakeLog(),
      preStopMs: 5_000,
      getServers: () => [srv],
      exit,
      random: () => 0.5,
      sleep,
    });

    expect(isApiDraining()).toBe(false);
    const done = shutdown("SIGTERM");
    await vi.waitFor(() => expect(srv.close).toHaveBeenCalledTimes(1));
    expect(srv.closeIdleConnections).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled(); // requisição em curso segura a saída
    order.push("requisicoes-terminaram");
    srv.finish();
    await done;

    expect(order).toEqual([
      "sse",
      "sleep:5000",
      "requisicoes-terminaram",
      "prisma",
      "exit:0",
    ]);
    expect(unregistered).not.toHaveBeenCalled();
    expect(retries).toEqual([sseShutdownRetryMs(() => 0.5)]);
    expect(srv.closeAllConnections).not.toHaveBeenCalled();
  });

  it("teto: derruba conexões e sai 1 quando as requisições não terminam", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const srv = fakeServer();
    const shutdown = createApiShutdown({
      log: fakeLog(),
      timeoutMs: 25_000,
      preStopMs: 0,
      getServers: () => [srv],
      exit,
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(srv.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // O close tardio não gera um segundo exit.
    srv.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("closer de SSE que falha não impede o resto; gancho que falha também não", async () => {
    const exit = vi.fn();
    const log = fakeLog();
    registerSseStream(() => {
      throw new Error("stream já fechado");
    });
    const ok = vi.fn();
    registerSseStream(ok);
    registerApiShutdownHook({
      name: "quebra",
      run: () => {
        throw new Error("boom");
      },
    });
    const depois = vi.fn();
    registerApiShutdownHook({ name: "depois", run: depois });
    const shutdown = createApiShutdown({
      log,
      preStopMs: 0,
      getServers: () => [],
      exit,
    });
    await shutdown("SIGTERM");
    expect(ok).toHaveBeenCalledTimes(1);
    expect(depois).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.warn).toHaveBeenCalledWith(
      "[api-shutdown] gancho falhou",
      expect.objectContaining({ hook: "quebra" }),
    );
  });

  it("segundo sinal não repete o shutdown", async () => {
    const exit = vi.fn();
    const shutdown = createApiShutdown({
      log: fakeLog(),
      preStopMs: 0,
      getServers: () => [],
      exit,
    });
    const p1 = shutdown("SIGTERM");
    const p2 = shutdown("SIGINT");
    expect(p2).toBe(p1);
    await p1;
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("installApiGracefulShutdown registra SIGTERM/SIGINT uma vez por processo", () => {
    const handlers = new Map<string, () => void>();
    const proc = {
      on: vi.fn((ev: string, fn: () => void) => {
        handlers.set(ev, fn);
        return proc;
      }),
    } as unknown as Pick<NodeJS.Process, "on">;
    const opts = { log: fakeLog(), exit: vi.fn(), getServers: () => [], preStopMs: 0 };
    expect(installApiGracefulShutdown(opts, proc)).toBeTypeOf("function");
    expect(installApiGracefulShutdown(opts, proc)).toBeNull();
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("gancho com o mesmo nome entra uma vez (módulo avaliado em mais de um bundle)", async () => {
    const run = vi.fn();
    registerApiShutdownHook({ name: "prisma", run });
    registerApiShutdownHook({ name: "prisma", run });
    await createApiShutdown({ log: fakeLog(), preStopMs: 0, getServers: () => [], exit: vi.fn() })(
      "SIGTERM",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retry do SSE fica na faixa e espalha", () => {
    expect(sseShutdownRetryMs(() => 0)).toBe(SSE_SHUTDOWN_RETRY_MIN_MS);
    expect(sseShutdownRetryMs(() => 0.999999)).toBeLessThan(SSE_SHUTDOWN_RETRY_MAX_MS);
    expect(sseShutdownRetryMs(() => 0.999999)).toBeGreaterThan(SSE_SHUTDOWN_RETRY_MAX_MS - 10);
    expect(sseShutdownRetryAfterSec(() => 0)).toBe(2);
    expect(sseShutdownRetryAfterSec(() => 0.999999)).toBe(15);
  });

  it("tempos vêm do ambiente; pré-parada nunca passa do teto", () => {
    expect(apiShutdownTimingsFromEnv({})).toEqual({ timeoutMs: 25_000, preStopMs: 5_000 });
    expect(
      apiShutdownTimingsFromEnv({ API_SHUTDOWN_TIMEOUT_MS: "40000", API_SHUTDOWN_PRESTOP_MS: "0" }),
    ).toEqual({ timeoutMs: 40_000, preStopMs: 0 });
    expect(
      apiShutdownTimingsFromEnv({ API_SHUTDOWN_TIMEOUT_MS: "3000", API_SHUTDOWN_PRESTOP_MS: "10000" }),
    ).toEqual({ timeoutMs: 3_000, preStopMs: 2_000 });
    expect(apiShutdownTimingsFromEnv({ API_SHUTDOWN_TIMEOUT_MS: "abc" }).timeoutMs).toBe(25_000);
  });
});
