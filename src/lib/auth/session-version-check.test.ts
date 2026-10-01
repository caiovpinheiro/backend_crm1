/**
 * SV-1: leitura da versão com banco — cache quente não consulta; cache
 * frio consulta uma vez e grava; linha ausente/erro = sem veredito
 * (fail-open) e não é cacheado. SV-2: `fresh` ignora o cache e claim à
 * frente do cache relê o banco (sessão renovada em outra réplica).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: mocks.warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  clearSessionVersionCacheForTests,
  getCachedSessionVersion,
  setCachedSessionVersion,
} from "@/lib/auth/session-version";
import {
  isSessionVersionCurrent,
  loadSessionVersion,
  resolveKnownSessionVersion,
} from "@/lib/auth/session-version-check";

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionVersionCacheForTests();
});

describe("loadSessionVersion", () => {
  it("cache quente: não consulta o banco", async () => {
    setCachedSessionVersion("u1", 4);
    expect(await loadSessionVersion("u1")).toBe(4);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("cache frio: consulta só sessionVersion e grava no cache", async () => {
    mocks.findUnique.mockResolvedValue({ sessionVersion: 2 });
    expect(await loadSessionVersion("u1")).toBe(2);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { sessionVersion: true },
    });
    expect(getCachedSessionVersion("u1")).toBe(2);
    await loadSessionVersion("u1");
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("linha ausente: null e nada em cache (tenta de novo)", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await loadSessionVersion("u1")).toBeNull();
    expect(getCachedSessionVersion("u1")).toBeNull();
    await loadSessionVersion("u1");
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("erro no banco: null, loga warn e não lança", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    expect(await loadSessionVersion("u1")).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("fresh: ignora o cache quente, consulta o banco e regrava o cache", async () => {
    setCachedSessionVersion("u1", 4);
    mocks.findUnique.mockResolvedValue({ sessionVersion: 5 });
    expect(await loadSessionVersion("u1", { fresh: true })).toBe(5);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(getCachedSessionVersion("u1")).toBe(5);
  });
});

describe("claim à frente do cache (SV-2)", () => {
  it("requireAuth em réplica com cache velho: relê o banco e aceita a sessão renovada", async () => {
    setCachedSessionVersion("u1", 3);
    mocks.findUnique.mockResolvedValue({ sessionVersion: 4 });
    expect(await isSessionVersionCurrent("u1", 4)).toBe(true);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    // Cache atualizado: a sessão antiga cai e a nova não consulta de novo.
    expect(await isSessionVersionCurrent("u1", 3)).toBe(false);
    expect(await isSessionVersionCurrent("u1", 4)).toBe(true);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("claim à frente do banco: relê, confirma a divergência e recusa", async () => {
    setCachedSessionVersion("u1", 3);
    mocks.findUnique.mockResolvedValue({ sessionVersion: 3 });
    expect(await isSessionVersionCurrent("u1", 7)).toBe(false);
  });

  it("claim igual ou atrás do cache: não consulta o banco", async () => {
    setCachedSessionVersion("u1", 3);
    expect(await resolveKnownSessionVersion("u1", 3, 3)).toBe(3);
    expect(await resolveKnownSessionVersion("u1", 2, 3)).toBe(3);
    expect(await resolveKnownSessionVersion("u1", 2, null)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe("isSessionVersionCurrent", () => {
  it("igual → true; banco incrementou → false; sem veredito → true", async () => {
    mocks.findUnique.mockResolvedValue({ sessionVersion: 1 });
    expect(await isSessionVersionCurrent("u1", 1)).toBe(true);

    clearSessionVersionCacheForTests();
    mocks.findUnique.mockResolvedValue({ sessionVersion: 2 });
    expect(await isSessionVersionCurrent("u1", 1)).toBe(false);

    clearSessionVersionCacheForTests();
    mocks.findUnique.mockResolvedValue(null);
    expect(await isSessionVersionCurrent("u1", 1)).toBe(true);
  });
});
