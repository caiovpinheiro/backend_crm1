/**
 * Perfis `auth.*` são "duros": com o Redis fora do ar o limite continua
 * valendo (limiter em memória), em vez de liberar tudo (fail-open). Os
 * demais perfis seguem fail-open. Redis falso, sem rede.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RATE_LIMIT_PROFILES,
  consumeRateLimit,
  hashRateLimitId,
  resetRateLimitersForTests,
  setRateLimitRedisForTests,
  withRateLimit,
} from "@/lib/rate-limit";
import { resetRateLimitRejectLogForTests } from "@/lib/rate-limit-reject-log";

/** Cliente no formato do ioredis em que todo comando falha (Redis caído). */
function brokenRedis(): Record<string, unknown> {
  const client: Record<string, unknown> = {
    status: "end",
    multi: () => ({}),
    defineCommand(name: string) {
      client[name] = () => Promise.reject(new Error("Connection is closed"));
    },
    set: () => Promise.reject(new Error("Connection is closed")),
  };
  return client;
}

beforeEach(() => {
  resetRateLimitersForTests();
  resetRateLimitRejectLogForTests({ emit: () => {} });
});

afterEach(() => {
  resetRateLimitersForTests();
  resetRateLimitRejectLogForTests();
});

describe("rate-limit — perfis auth.* com Redis indisponível", () => {
  it("auth.lookup.email: bloqueia depois do teto mesmo com o Redis caído", async () => {
    setRateLimitRedisForTests(brokenRedis());
    const limit = RATE_LIMIT_PROFILES["auth.lookup.email"].points;
    const id = hashRateLimitId("ana@acme.com");
    for (let i = 0; i < limit; i += 1) {
      const rl = await withRateLimit({
        route: "auth.tenant-lookup",
        profile: "auth.lookup.email",
        scope: "email",
        id,
      });
      expect(rl.ok).toBe(true);
    }
    const blocked = await withRateLimit({
      route: "auth.tenant-lookup",
      profile: "auth.lookup.email",
      scope: "email",
      id,
    });
    expect(blocked.ok).toBe(false);
    // Outro e-mail tem balde próprio.
    const other = await withRateLimit({
      route: "auth.tenant-lookup",
      profile: "auth.lookup.email",
      scope: "email",
      id: hashRateLimitId("bia@acme.com"),
    });
    expect(other.ok).toBe(true);
  });

  it("auth.public e auth.credentials (login, lookup, reset, signup) também não liberam", async () => {
    setRateLimitRedisForTests(brokenRedis());
    for (const profile of ["auth.public", "auth.credentials"] as const) {
      const limit = RATE_LIMIT_PROFILES[profile].points;
      for (let i = 0; i < limit; i += 1) {
        expect((await consumeRateLimit(`ip:203.0.113.9:${profile}`, profile)).allowed).toBe(true);
      }
      expect((await consumeRateLimit(`ip:203.0.113.9:${profile}`, profile)).allowed).toBe(false);
    }
  });

  it("perfil fora de auth.* continua fail-open", async () => {
    setRateLimitRedisForTests(brokenRedis());
    const limit = RATE_LIMIT_PROFILES["api.bulk"].points;
    for (let i = 0; i < limit + 3; i += 1) {
      expect((await consumeRateLimit("org:o1:bulk", "api.bulk")).allowed).toBe(true);
    }
  });
});

describe("hashRateLimitId", () => {
  it("é estável, opaco e não contém o e-mail", () => {
    const a = hashRateLimitId("ana@acme.com");
    expect(a).toBe(hashRateLimitId("ana@acme.com"));
    expect(a).not.toBe(hashRateLimitId("bia@acme.com"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("ana");
  });
});
