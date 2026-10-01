import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@/lib/logger";

import { createGracefulShutdown, installGracefulShutdown } from "./graceful-shutdown";

function fakeLog(): Logger {
  const noop = vi.fn();
  const l = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: vi.fn(),
    error: vi.fn(),
    fatal: noop,
    child: () => l,
    raw: () => {
      throw new Error("n/a");
    },
  } as unknown as Logger;
  return l;
}

describe("createGracefulShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("roda os passos em ordem, faz flush do logger e sai com 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const flushLogger = vi.fn(async () => {
      order.push("flush");
    });
    const shutdown = createGracefulShutdown({
      name: "t",
      log: fakeLog(),
      exit,
      flushLogger,
      steps: [
        { name: "a", run: () => order.push("a") },
        {
          name: "b",
          run: async () => {
            await Promise.resolve();
            order.push("b");
          },
        },
      ],
    });
    await shutdown("SIGTERM");
    expect(order).toEqual(["a", "b", "flush"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("passo que falha não impede os seguintes", async () => {
    const exit = vi.fn();
    const after = vi.fn();
    const log = fakeLog();
    const shutdown = createGracefulShutdown({
      name: "t",
      log,
      exit,
      flushLogger: async () => {},
      steps: [
        {
          name: "quebra",
          run: async () => {
            throw new Error("boom");
          },
        },
        { name: "depois", run: after },
      ],
    });
    await shutdown("SIGTERM");
    expect(after).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("segunda chamada não repete os passos", async () => {
    const exit = vi.fn();
    const step = vi.fn();
    const shutdown = createGracefulShutdown({
      name: "t",
      log: fakeLog(),
      exit,
      flushLogger: async () => {},
      steps: [{ name: "s", run: step }],
    });
    const p1 = shutdown("SIGTERM");
    const p2 = shutdown("SIGINT");
    expect(p2).toBe(p1);
    await p1;
    await shutdown("SIGTERM");
    expect(step).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("passo travado: timer de segurança sai com 1 e não chama exit(0) depois", async () => {
    const exit = vi.fn();
    let release!: () => void;
    const hung = new Promise<void>((r) => {
      release = r;
    });
    const later = vi.fn();
    const shutdown = createGracefulShutdown({
      name: "t",
      log: fakeLog(),
      exit,
      timeoutMs: 1_000,
      flushLogger: async () => {},
      steps: [
        { name: "trava", run: () => hung },
        { name: "depois", run: later },
      ],
    });
    const p = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).toHaveBeenCalledWith(1);
    release();
    await p;
    expect(later).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("installGracefulShutdown", () => {
  it("registra SIGTERM e SIGINT", async () => {
    const handlers = new Map<string, () => void>();
    const proc = {
      on: (ev: string, fn: () => void) => {
        handlers.set(ev, fn);
        return proc;
      },
    } as unknown as Pick<NodeJS.Process, "on">;
    const exit = vi.fn();
    installGracefulShutdown(
      { name: "t", log: fakeLog(), exit, flushLogger: async () => {}, steps: [] },
      proc,
    );
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
