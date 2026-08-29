/**
 * 100 rejeições do mesmo IP em 10s → 1 log com count=100.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_REJECT_LOG_WINDOW_MS,
  flushRateLimitRejectLogs,
  logRateLimitReject,
  resetRateLimitRejectLogForTests,
} from "@/lib/rate-limit-reject-log";

type Line = Record<string, unknown>;

function capture(): Line[] {
  const lines: Line[] = [];
  resetRateLimitRejectLogForTests({
    emit: (obj) => {
      lines.push(obj);
    },
  });
  return lines;
}

afterEach(() => {
  resetRateLimitRejectLogForTests();
  vi.useRealTimers();
});

describe("logRateLimitReject", () => {
  it("100 rejeições do mesmo IP em 10s geram 1 linha (1ª da janela)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T20:00:00.000Z"));
    const lines = capture();

    for (let i = 0; i < 100; i += 1) {
      logRateLimitReject("ip:203.0.113.9", {
        profile: "auth.public",
        scope: "ip",
        ip: "203.0.113.9",
        route: "organization.by-slug",
        limit: 10,
        retryAfterSec: 50,
      });
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "rate_limit_rejected",
      key: "ip:203.0.113.9",
      count: 1,
      blockedSince: "2026-08-28T20:00:00.000Z",
      windowMs: 10_000,
      profile: "auth.public",
      scope: "ip",
      ip: "203.0.113.9",
      route: "organization.by-slug",
      limit: 10,
      retryAfterSec: 50,
    });

    vi.advanceTimersByTime(RATE_LIMIT_REJECT_LOG_WINDOW_MS);
    expect(lines).toHaveLength(1);
  });

  it("janela seguinte volta a emitir 1 linha (não acumula o flood anterior)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T20:00:00.000Z"));
    const lines = capture();

    for (let i = 0; i < 100; i += 1) {
      logRateLimitReject("ip:203.0.113.9", { ip: "203.0.113.9", scope: "ip" });
    }
    vi.advanceTimersByTime(RATE_LIMIT_REJECT_LOG_WINDOW_MS);
    for (let i = 0; i < 15; i += 1) {
      logRateLimitReject("ip:203.0.113.9", { ip: "203.0.113.9", scope: "ip" });
    }

    expect(lines).toHaveLength(2);
    expect(lines[0].count).toBe(1);
    expect(lines[1].count).toBe(1);
  });

  it("chaves distintas não se misturam", () => {
    const lines = capture();
    logRateLimitReject("ip:10.0.0.1", { ip: "10.0.0.1" });
    logRateLimitReject("ip:10.0.0.2", { ip: "10.0.0.2" });
    flushRateLimitRejectLogs();
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.key).sort()).toEqual(["ip:10.0.0.1", "ip:10.0.0.2"]);
    expect(lines.every((l) => l.count === 1)).toBe(true);
  });

  it("loga só prefixo do hash do token, nunca o hash inteiro nem o Bearer", () => {
    const lines = capture();
    const hash = "a".repeat(64);
    logRateLimitReject(`token:${hash}`, {
      profile: "api.token",
      scope: "token",
      tokenHashPrefix: hash,
    });
    flushRateLimitRejectLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0].tokenHashPrefix).toBe("a".repeat(12));
    expect(lines[0].key).toBe(`token:${"a".repeat(12)}`);
    expect(JSON.stringify(lines[0])).not.toContain("a".repeat(64));
    expect(JSON.stringify(lines[0])).not.toContain("eduit_");
  });

  it("no teto de chaves, evicta LRU emitindo a contagem pendente", () => {
    const lines: Line[] = [];
    resetRateLimitRejectLogForTests({
      maxKeys: 2,
      emit: (obj) => {
        lines.push(obj);
      },
    });
    logRateLimitReject("ip:1.1.1.1", { ip: "1.1.1.1" });
    logRateLimitReject("ip:1.1.1.1", { ip: "1.1.1.1" });
    logRateLimitReject("ip:2.2.2.2", { ip: "2.2.2.2" });
    logRateLimitReject("ip:3.3.3.3", { ip: "3.3.3.3" });
    expect(lines.map((l) => l.key)).toEqual([
      "ip:1.1.1.1",
      "ip:2.2.2.2",
      "ip:3.3.3.3",
    ]);
    expect(lines[0].count).toBe(1);
    flushRateLimitRejectLogs();
    expect(lines.map((l) => l.key)).toEqual([
      "ip:1.1.1.1",
      "ip:2.2.2.2",
      "ip:3.3.3.3",
    ]);
  });
});
