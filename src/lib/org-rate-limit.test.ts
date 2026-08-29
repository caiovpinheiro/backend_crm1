import { afterEach, describe, expect, it } from "vitest";

import {
  consumeOrgRpm,
  enforceOrgApiRateLimit,
  getOrgRateLimitRpm,
  isOrgRpmExemptPath,
  orgRateLimitResponse,
  orgRpmKey,
  resetOrgRpmMemoryForTests,
} from "@/lib/org-rate-limit";
import {
  DEFAULT_ORG_RATE_LIMIT_RPM,
  isInboxHotSessionPath,
} from "@/lib/org-rate-limit-config";

afterEach(() => {
  resetOrgRpmMemoryForTests();
});

describe("org RPM config", () => {
  it("usa 400 por padrão e aceita ORG_RATE_LIMIT_RPM", () => {
    const prev = process.env.ORG_RATE_LIMIT_RPM;
    delete process.env.ORG_RATE_LIMIT_RPM;
    expect(getOrgRateLimitRpm()).toBe(DEFAULT_ORG_RATE_LIMIT_RPM);
    process.env.ORG_RATE_LIMIT_RPM = "250";
    expect(getOrgRateLimitRpm()).toBe(250);
    process.env.ORG_RATE_LIMIT_RPM = "0";
    expect(getOrgRateLimitRpm()).toBe(DEFAULT_ORG_RATE_LIMIT_RPM);
    process.env.ORG_RATE_LIMIT_RPM = "nope";
    expect(getOrgRateLimitRpm()).toBe(DEFAULT_ORG_RATE_LIMIT_RPM);
    if (prev === undefined) delete process.env.ORG_RATE_LIMIT_RPM;
    else process.env.ORG_RATE_LIMIT_RPM = prev;
  });

  it("chave isolada por lane", () => {
    expect(orgRpmKey("org_abc")).toBe("org:org_abc:rpm:token");
    expect(orgRpmKey("org_abc", "token")).toBe("org:org_abc:rpm:token");
    expect(orgRpmKey("org_abc", "session")).toBe("org:org_abc:rpm:session");
  });

  it("marca GET quentes do inbox", () => {
    expect(isInboxHotSessionPath("/api/conversations")).toBe(true);
    expect(isInboxHotSessionPath("/api/conversations/abc/messages")).toBe(true);
    expect(isInboxHotSessionPath("/api/conversations/abc")).toBe(false);
    expect(isInboxHotSessionPath("/api/contacts")).toBe(false);
  });

  it("isenta webhooks, health, cron e auth", () => {
    expect(isOrgRpmExemptPath("/api/webhooks/meta")).toBe(true);
    expect(isOrgRpmExemptPath("/api/webhooks/meta/acme/messaging")).toBe(true);
    expect(isOrgRpmExemptPath("/api/health")).toBe(true);
    expect(isOrgRpmExemptPath("/api/cron/sweep")).toBe(true);
    expect(isOrgRpmExemptPath("/api/auth/callback/credentials")).toBe(true);
    expect(isOrgRpmExemptPath("/api/contacts")).toBe(false);
    expect(isOrgRpmExemptPath("/api/public/agent-cockpit")).toBe(false);
  });
});

describe("consumeOrgRpm (memória)", () => {
  it("permite 400, bloqueia a 401ª e reseta na janela seguinte", async () => {
    const organizationId = `org-rpm-${Date.now()}`;
    const t0 = 1_700_000_000_000;
    const windowMs = 60_000;
    const limit = 400;

    for (let i = 0; i < limit; i += 1) {
      const decision = await consumeOrgRpm(organizationId, {
        store: "memory",
        now: t0,
        limit,
        windowMs,
      });
      expect(decision.allowed, `req ${i + 1} deveria passar`).toBe(true);
      expect(decision.limit).toBe(limit);
      expect(decision.remaining).toBe(limit - i - 1);
    }

    const blocked = await consumeOrgRpm(organizationId, {
      store: "memory",
      now: t0,
      limit,
      windowMs,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    const nextWindow = await consumeOrgRpm(organizationId, {
      store: "memory",
      now: t0 + windowMs,
      limit,
      windowMs,
    });
    expect(nextWindow.allowed).toBe(true);
    expect(nextWindow.remaining).toBe(limit - 1);
  });

  it("isola buckets session e token da mesma org", async () => {
    const now = Date.now();
    const token = await consumeOrgRpm("org-lane", {
      store: "memory",
      now,
      limit: 1,
      lane: "token",
    });
    const session = await consumeOrgRpm("org-lane", {
      store: "memory",
      now,
      limit: 1,
      lane: "session",
    });
    const token2 = await consumeOrgRpm("org-lane", {
      store: "memory",
      now,
      limit: 1,
      lane: "token",
    });
    expect(token.allowed).toBe(true);
    expect(session.allowed).toBe(true);
    expect(token2.allowed).toBe(false);
  });

  it("isola buckets por organização", async () => {
    const now = Date.now();
    const a = await consumeOrgRpm("org-a", { store: "memory", now, limit: 1 });
    const b = await consumeOrgRpm("org-b", { store: "memory", now, limit: 1 });
    const a2 = await consumeOrgRpm("org-a", { store: "memory", now, limit: 1 });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(a2.allowed).toBe(false);
  });
});

describe("org 429", () => {
  it("corpo canônico + headers", async () => {
    const res = orgRateLimitResponse({
      allowed: false,
      limit: 400,
      remaining: 0,
      retryAfterSec: 12,
      resetAt: 1_700_000_012_000,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("400");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("1700000012");
    await expect(res.json()).resolves.toEqual({
      error: "rate_limit",
      message: "Muitas requisições. Tente novamente em instantes.",
      limit: 400,
      retryAfterSec: 12,
    });
  });

  it("enforce isenta super-admin, sem org, webhook e sessão", async () => {
    expect(
      await enforceOrgApiRateLimit({
        organizationId: "org-x",
        isSuperAdmin: true,
        viaToken: true,
      }),
    ).toBeNull();
    expect(await enforceOrgApiRateLimit({ organizationId: null })).toBeNull();
    expect(
      await enforceOrgApiRateLimit({
        organizationId: "org-x",
        pathname: "/api/webhooks/meta",
        viaToken: true,
      }),
    ).toBeNull();
    expect(
      await enforceOrgApiRateLimit({
        organizationId: "org-x",
        pathname: "/api/conversations/abc/messages",
        viaToken: false,
      }),
    ).toBeNull();
  });
});
