/**
 * Teto por sessão cookie (`api.session` via consumeRateLimit).
 * Loop de render (~15 req/s) estoura; a janela seguinte libera de novo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireAuth } from "@/lib/auth-helpers";
import { resetOrgRpmMemoryForTests } from "@/lib/org-rate-limit";
import {
  DEFAULT_SESSION_RATE_LIMIT_RPM,
  enforceSessionApiRateLimit,
  getSessionRateLimitRpm,
  resetRateLimitersForTests,
  sessionRateLimitKey,
} from "@/lib/rate-limit";
import { resetRateLimitRejectLogForTests } from "@/lib/rate-limit-reject-log";

const mockedAuth = vi.mocked(auth);

function restoreSessionRpm(prev: string | undefined): void {
  if (prev === undefined) delete process.env.SESSION_RATE_LIMIT_RPM;
  else process.env.SESSION_RATE_LIMIT_RPM = prev;
}

beforeEach(() => {
  resetRateLimitersForTests();
  resetRateLimitRejectLogForTests({ emit: () => {} });
  resetOrgRpmMemoryForTests();
});

afterEach(() => {
  resetRateLimitRejectLogForTests();
  resetRateLimitersForTests();
  vi.useRealTimers();
});

describe("getSessionRateLimitRpm", () => {
  it("default 600 e aceita SESSION_RATE_LIMIT_RPM", () => {
    const prev = process.env.SESSION_RATE_LIMIT_RPM;
    delete process.env.SESSION_RATE_LIMIT_RPM;
    expect(getSessionRateLimitRpm()).toBe(DEFAULT_SESSION_RATE_LIMIT_RPM);
    process.env.SESSION_RATE_LIMIT_RPM = "800";
    expect(getSessionRateLimitRpm()).toBe(800);
    process.env.SESSION_RATE_LIMIT_RPM = "0";
    expect(getSessionRateLimitRpm()).toBe(DEFAULT_SESSION_RATE_LIMIT_RPM);
    restoreSessionRpm(prev);
  });

  it("chave session:{userId}", () => {
    expect(sessionRateLimitKey("user_abc")).toBe("session:user_abc");
  });
});

describe("enforceSessionApiRateLimit (consume)", () => {
  it("estoura o teto com 429 + headers e libera na janela seguinte", async () => {
    const prev = process.env.SESSION_RATE_LIMIT_RPM;
    process.env.SESSION_RATE_LIMIT_RPM = "2";
    resetRateLimitersForTests();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));

    const userId = "user-loop-consume";
    const organizationId = "org-loop";

    const first = await enforceSessionApiRateLimit({ userId, organizationId });
    const second = await enforceSessionApiRateLimit({ userId, organizationId });
    expect(first).toBeNull();
    expect(second).toBeNull();

    const blocked = await enforceSessionApiRateLimit({ userId, organizationId });
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).toBeTruthy();
    expect(blocked!.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(blocked!.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(blocked!.headers.get("X-RateLimit-Reset")).toBeTruthy();
    await expect(blocked!.json()).resolves.toMatchObject({
      error: "rate_limit_exceeded",
      retryAfterSec: expect.any(Number),
    });

    vi.advanceTimersByTime(60_000);

    const nextWindow = await enforceSessionApiRateLimit({
      userId,
      organizationId,
    });
    expect(nextWindow).toBeNull();

    restoreSessionRpm(prev);
  });

  it("isola buckets por userId", async () => {
    const prev = process.env.SESSION_RATE_LIMIT_RPM;
    process.env.SESSION_RATE_LIMIT_RPM = "1";
    resetRateLimitersForTests();

    const a = await enforceSessionApiRateLimit({ userId: "user-a" });
    const b = await enforceSessionApiRateLimit({ userId: "user-b" });
    const a2 = await enforceSessionApiRateLimit({ userId: "user-a" });
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(a2?.status).toBe(429);

    restoreSessionRpm(prev);
  });
});

describe("requireAuth enforces session RPM", () => {
  it("usuário da sessão estoura o teto com 429; janela seguinte ok", async () => {
    const prev = process.env.SESSION_RATE_LIMIT_RPM;
    process.env.SESSION_RATE_LIMIT_RPM = "2";
    resetRateLimitersForTests();

    mockedAuth.mockResolvedValue({
      user: {
        id: "user-require-auth",
        name: "Loop",
        email: "loop@example.com",
        role: "MEMBER",
        organizationId: "org-require-auth",
        isSuperAdmin: false,
      },
    } as never);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T13:00:00.000Z"));

    const first = await requireAuth();
    const second = await requireAuth();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const blocked = await requireAuth();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.response.status).toBe(429);
      expect(blocked.response.headers.get("Retry-After")).toBeTruthy();
      expect(blocked.response.headers.get("X-RateLimit-Limit")).toBe("2");
    }

    vi.advanceTimersByTime(60_000);

    const nextWindow = await requireAuth();
    expect(nextWindow.ok).toBe(true);

    restoreSessionRpm(prev);
  });
});
