/**
 * SEC-18 / RT-13 — expiração OPCIONAL (sem env não expira; com
 * `API_TOKEN_DEFAULT_EXPIRY_DAYS` aplica um padrão), cache por hash (60 s)
 * e `lastUsedAt` no máximo 1×/min.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnique, update, deleteMany, findFirst, logAudit } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { apiToken: { create, findUnique, update, deleteMany, findFirst } },
}));
vi.mock("@/lib/audit/log", () => ({ logAudit }));

import {
  API_TOKEN_CACHE_TTL_MS,
  API_TOKEN_DEFAULT_EXPIRY_ENV,
  generateToken,
  invalidateApiTokenCache,
  revokeToken,
  validateToken,
} from "./api-tokens";

const DAY = 24 * 60 * 60 * 1000;

function record(overrides: Partial<{ expiresAt: Date | null; status: string }> = {}) {
  return {
    id: "tok1",
    name: "n8n",
    userId: "u1",
    organizationId: "org1",
    expiresAt: overrides.expiresAt === undefined ? new Date(Date.now() + 30 * DAY) : overrides.expiresAt,
    user: {
      id: "u1",
      name: "User",
      email: "u@x.com",
      role: "ADMIN",
      organizationId: "org1",
      isSuperAdmin: false,
      organization: { status: overrides.status ?? "ACTIVE" },
    },
  };
}

describe("generateToken — expiração opcional", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    create.mockResolvedValue({ id: "tok1" });
    logAudit.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sem expiresAt e sem API_TOKEN_DEFAULT_EXPIRY_DAYS → token não expira", async () => {
    const r = await generateToken("u1", "org1", "n8n", null);
    expect(r.token.startsWith("eduit_")).toBe(true);
    expect(r.expiresAt).toBeNull();
    const data = create.mock.calls[0][0].data as { expiresAt: Date | null };
    expect(data.expiresAt).toBeNull();
  });

  it("com API_TOKEN_DEFAULT_EXPIRY_DAYS=90 → expira em 90 dias", async () => {
    vi.stubEnv(API_TOKEN_DEFAULT_EXPIRY_ENV, "90");
    const before = Date.now();
    const r = await generateToken("u1", "org1", "n8n", null);
    expect(r.expiresAt).toBeInstanceOf(Date);
    expect(Math.round((r.expiresAt!.getTime() - before) / DAY)).toBe(90);
    const data = create.mock.calls[0][0].data as { expiresAt: Date | null };
    expect(data.expiresAt?.getTime()).toBe(r.expiresAt!.getTime());
  });

  it("env inválida ou zero → não expira", async () => {
    vi.stubEnv(API_TOKEN_DEFAULT_EXPIRY_ENV, "abc");
    expect((await generateToken("u1", "org1", "a", null)).expiresAt).toBeNull();
    vi.stubEnv(API_TOKEN_DEFAULT_EXPIRY_ENV, "0");
    expect((await generateToken("u1", "org1", "b", null)).expiresAt).toBeNull();
  });

  it("expiresAt explícito é respeitado (mesmo com env ligada)", async () => {
    vi.stubEnv(API_TOKEN_DEFAULT_EXPIRY_ENV, "90");
    const custom = new Date(Date.now() + 7 * DAY);
    const r = await generateToken("u1", "org1", "n8n", custom);
    expect(r.expiresAt?.getTime()).toBe(custom.getTime());
  });
});

describe("validateToken — cache e lastUsedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateApiTokenCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    update.mockReturnValue({ catch: () => undefined });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("segunda chamada dentro de 60 s não consulta o banco nem grava lastUsedAt de novo", async () => {
    findUnique.mockResolvedValue(record());
    const a = await validateToken("eduit_abc");
    const b = await validateToken("eduit_abc");
    expect(a?.tokenId).toBe("tok1");
    expect(b?.tokenId).toBe("tok1");
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(API_TOKEN_CACHE_TTL_MS + 1);
    await validateToken("eduit_abc");
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("token expirado → null e não grava lastUsedAt", async () => {
    findUnique.mockResolvedValue(record({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await validateToken("eduit_old")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("expira dentro da janela do cache", async () => {
    findUnique.mockResolvedValue(record({ expiresAt: new Date(Date.now() + 10_000) }));
    expect(await validateToken("eduit_soon")).not.toBeNull();
    vi.advanceTimersByTime(20_000);
    expect(await validateToken("eduit_soon")).toBeNull();
  });

  it("org inativa → null", async () => {
    findUnique.mockResolvedValue(record({ status: "SUSPENDED" }));
    expect(await validateToken("eduit_susp")).toBeNull();
  });

  it("revogar limpa o cache do token", async () => {
    findUnique.mockResolvedValue(record());
    await validateToken("eduit_rev");
    findFirst.mockResolvedValue({ id: "tok1", name: "n8n", tokenPrefix: "eduit_rev", createdAt: new Date() });
    deleteMany.mockResolvedValue({ count: 1 });
    logAudit.mockResolvedValue(undefined);
    await revokeToken("tok1", "u1", "org1");
    findUnique.mockResolvedValue(null);
    expect(await validateToken("eduit_rev")).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
