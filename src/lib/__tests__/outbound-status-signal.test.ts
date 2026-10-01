/**
 * Sinal de status do worker meta-outbound via Redis pub/sub (RT-7 / P-8).
 * ioredis mockado: um "bus" em memória liga publish ↔ message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => {
  type Handler = (channel: string, raw: string) => void;
  const state = {
    handlers: [] as Handler[],
    subscribed: [] as string[],
    unsubscribed: [] as string[],
    published: [] as Array<{ channel: string; raw: string }>,
    subscribeRejects: false,
  };
  class FakeRedis {
    status = "ready";
    constructor(_url: string, _opts?: unknown) {}
    connect() {
      return Promise.resolve();
    }
    disconnect() {}
    on(event: string, fn: Handler) {
      if (event === "message") state.handlers.push(fn);
      return this;
    }
    subscribe(channel: string) {
      if (state.subscribeRejects) return Promise.reject(new Error("down"));
      state.subscribed.push(channel);
      return Promise.resolve(1);
    }
    unsubscribe(channel: string) {
      state.unsubscribed.push(channel);
      return Promise.resolve(0);
    }
    publish(channel: string, raw: string) {
      state.published.push({ channel, raw });
      for (const h of state.handlers) h(channel, raw);
      return Promise.resolve(1);
    }
  }
  return { state, FakeRedis };
});

vi.mock("ioredis", () => ({ default: bus.FakeRedis }));

import {
  __resetOutboundStatusSignalForTests,
  OUTBOUND_STATUS_CHANNEL_PREFIX,
  outboundStatusChannel,
  publishOutboundStatus,
  subscribeOutboundStatus,
} from "@/lib/outbound-status-signal";

beforeEach(() => {
  vi.useFakeTimers();
  process.env.REDIS_URL = "redis://localhost:6379";
  __resetOutboundStatusSignalForTests();
  bus.state.handlers.length = 0;
  bus.state.subscribed.length = 0;
  bus.state.unsubscribed.length = 0;
  bus.state.published.length = 0;
  bus.state.subscribeRejects = false;
});
afterEach(() => {
  __resetOutboundStatusSignalForTests();
  delete process.env.REDIS_URL;
  vi.useRealTimers();
});

describe("outbound-status-signal", () => {
  it("canal é crm:outbound:status:<messageId>", () => {
    expect(outboundStatusChannel("abc")).toBe(`${OUTBOUND_STATUS_CHANNEL_PREFIX}abc`);
  });

  it("publish do worker resolve o subscribe da API e faz unsubscribe", async () => {
    const sub = subscribeOutboundStatus("m1", { timeoutMs: 5_000 });
    await expect(sub.ready).resolves.toBe(true);
    expect(bus.state.subscribed).toEqual(["crm:outbound:status:m1"]);

    await publishOutboundStatus("m1", "sent");
    await expect(sub.promise).resolves.toBe("sent");
    expect(bus.state.published[0].channel).toBe("crm:outbound:status:m1");
    expect(JSON.parse(bus.state.published[0].raw).status).toBe("sent");
    expect(bus.state.unsubscribed).toEqual(["crm:outbound:status:m1"]);
  });

  it("sem publish resolve null no timeout", async () => {
    const sub = subscribeOutboundStatus("m2", { timeoutMs: 1_000 });
    await sub.ready;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sub.promise).resolves.toBeNull();
  });

  it("publish em outro canal não acorda; payload inválido é ignorado", async () => {
    const sub = subscribeOutboundStatus("m3", { timeoutMs: 1_000 });
    await sub.ready;
    await publishOutboundStatus("outro", "failed");
    for (const h of bus.state.handlers) h("crm:outbound:status:m3", "{nope");
    let settled = false;
    void sub.promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    await publishOutboundStatus("m3", "failed");
    await expect(sub.promise).resolves.toBe("failed");
  });

  it("sem REDIS_URL: publish é no-op e subscribe resolve null com ready=false", async () => {
    delete process.env.REDIS_URL;
    __resetOutboundStatusSignalForTests();
    await expect(publishOutboundStatus("m4", "sent")).resolves.toBeUndefined();
    const sub = subscribeOutboundStatus("m4", { timeoutMs: 1_000 });
    await expect(sub.ready).resolves.toBe(false);
    await expect(sub.promise).resolves.toBeNull();
    expect(bus.state.published).toEqual([]);
  });

  it("SUBSCRIBE que falha deixa ready=false mas o polling de fallback segue", async () => {
    bus.state.subscribeRejects = true;
    const sub = subscribeOutboundStatus("m5", { timeoutMs: 1_000 });
    await expect(sub.ready).resolves.toBe(false);
    sub.dispose();
    await expect(sub.promise).resolves.toBeNull();
  });
});
