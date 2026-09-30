/**
 * RT-7 / P-8: `waitForMessageSendStatus` acorda pelo sinal do worker e só
 * usa polling (com backoff 250 → 2000 ms) como fallback; teto de 15 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signalState = vi.hoisted(() => ({
  resolve: null as null | ((s: "sent" | "failed" | null) => void),
  ready: true,
  disposed: 0,
  subscribed: [] as string[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { message: { findUnique: vi.fn(async () => null) } },
}));
vi.mock("@/lib/outbound-status-signal", () => ({
  subscribeOutboundStatus: vi.fn((messageId: string) => {
    signalState.subscribed.push(messageId);
    const promise = new Promise<"sent" | "failed" | null>((resolve) => {
      signalState.resolve = resolve;
    });
    return {
      promise,
      ready: Promise.resolve(signalState.ready),
      dispose: () => {
        signalState.disposed += 1;
      },
    };
  }),
}));

import {
  DEFAULT_WAIT_SEND_TIMEOUT_MS,
  WAIT_SEND_POLL_MAX_MS,
  WAIT_SEND_POLL_MIN_MS,
  waitForMessageSendStatus,
} from "@/lib/wait-message-send-status";

/** sleep que registra as durações e respeita os fake timers. */
function makeSleep() {
  const calls: number[] = [];
  const sleep = (ms: number) => {
    calls.push(ms);
    return new Promise<void>((r) => setTimeout(r, ms));
  };
  return { calls, sleep };
}

beforeEach(() => {
  vi.useFakeTimers();
  signalState.resolve = null;
  signalState.ready = true;
  signalState.disposed = 0;
  signalState.subscribed.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("waitForMessageSendStatus", () => {
  it("teto padrão é 15 s e o polling faz backoff 250 → 2000", async () => {
    expect(DEFAULT_WAIT_SEND_TIMEOUT_MS).toBe(15_000);
    const { calls, sleep } = makeSleep();
    const readStatus = vi.fn(async () => "pending");

    const p = waitForMessageSendStatus("m1", DEFAULT_WAIT_SEND_TIMEOUT_MS, {
      readStatus,
      sleep,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toBe("timeout");

    expect(calls.slice(0, 5)).toEqual([250, 500, 1000, 2000, 2000]);
    expect(Math.max(...calls)).toBe(WAIT_SEND_POLL_MAX_MS);
    expect(calls[0]).toBe(WAIT_SEND_POLL_MIN_MS);
    // 250+500+1000+2000×6+1250 = 15 s → 11 leituras (era 160 com 250 ms × 40 s)
    expect(readStatus).toHaveBeenCalledTimes(11);
    expect(signalState.disposed).toBe(1);
  });

  it("sinal do worker acorda antes do próximo poll", async () => {
    const { sleep } = makeSleep();
    const readStatus = vi.fn(async () => "pending");

    const p = waitForMessageSendStatus("m2", 15_000, { readStatus, sleep });
    await vi.advanceTimersByTimeAsync(10);
    expect(signalState.subscribed).toEqual(["m2"]);
    signalState.resolve!("sent");
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe("sent");
    // 1 leitura inicial, nenhuma depois — o sinal venceu o sleep de 250 ms
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it("status já final no banco devolve sem esperar", async () => {
    const { calls, sleep } = makeSleep();
    const readStatus = vi.fn(async () => "failed");
    await expect(
      waitForMessageSendStatus("m3", 15_000, { readStatus, sleep }),
    ).resolves.toBe("failed");
    expect(calls).toEqual([]);
  });

  it("sem Redis (sinal resolve null) continua só no polling até o banco responder", async () => {
    const { calls, sleep } = makeSleep();
    let n = 0;
    const readStatus = vi.fn(async () => (++n >= 3 ? "sent" : "pending"));
    signalState.ready = false;

    const p = waitForMessageSendStatus("m4", 15_000, { readStatus, sleep });
    await vi.advanceTimersByTimeAsync(0);
    signalState.resolve!(null);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe("sent");
    expect(calls.length).toBeGreaterThan(0);
    expect(readStatus).toHaveBeenCalledTimes(3);
  });
});
