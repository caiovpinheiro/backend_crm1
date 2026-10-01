/**
 * SEC-20: `requireCronSecret` — header Bearer preferido, `?secret=` como
 * fallback deprecado (com aviso), comparação timing-safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

// O log saiu do `console` e foi para o logger estruturado: o teste espiona
// o logger e mantém a mesma garantia sobre o que é (e não é) logado.
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warn,
    error: vi.fn(),
  }),
}));


vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

import {
  requireCronSecret,
  resetCronSecretWarningsForTests,
  secretsMatch,
} from "@/lib/auth/cron-secret";

const SECRET = "s3cr3t-cron-token";

function req(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe("requireCronSecret", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    resetCronSecretWarningsForTests();
    warn.mockClear();
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("503 quando CRON_SECRET nao esta configurado", async () => {
    delete process.env.CRON_SECRET;
    const res = requireCronSecret(req("https://api.test/api/cron/x"));
    expect(res?.status).toBe(503);
  });

  it("aceita Authorization: Bearer sem aviso", () => {
    const res = requireCronSecret(
      req("https://api.test/api/cron/x", { authorization: `Bearer ${SECRET}` }),
    );
    expect(res).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("aceita ?secret= (fallback) e loga aviso de deprecacao 1x por rota", () => {
    const url = `https://api.test/api/cron/x?secret=${SECRET}`;
    expect(requireCronSecret(req(url))).toBeNull();
    expect(requireCronSecret(req(url))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("DEPRECADO");
  });

  it("401 com segredo errado no header, mesmo com ?secret= certo", () => {
    // O header, quando presente, vence — nao cai no fallback.
    const res = requireCronSecret(
      req(`https://api.test/api/cron/x?secret=${SECRET}`, {
        authorization: "Bearer errado",
      }),
    );
    expect(res?.status).toBe(401);
  });

  it("401 sem credencial e com segredo de tamanho diferente / prefixo igual", () => {
    expect(requireCronSecret(req("https://api.test/api/cron/x"))?.status).toBe(401);
    expect(
      requireCronSecret(
        req("https://api.test/api/cron/x", { authorization: `Bearer ${SECRET}x` }),
      )?.status,
    ).toBe(401);
    expect(
      requireCronSecret(
        req("https://api.test/api/cron/x", { authorization: `Bearer ${SECRET.slice(0, -1)}` }),
      )?.status,
    ).toBe(401);
  });

  it("secretsMatch usa timingSafeEqual (mesmo tamanho) e recusa vazio", () => {
    timingSafeEqualSpy.mockClear();
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
    expect(secretsMatch("", "")).toBe(false);
    // Tamanhos diferentes: recusa antes de comparar (timingSafeEqual lancaria).
    expect(secretsMatch("ab", "abc")).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });
});
