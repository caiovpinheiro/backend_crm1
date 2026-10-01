/**
 * SV-1: leitura da versão com banco — cache quente não consulta; cache
 * frio consulta uma vez e grava; linha ausente/erro = sem veredito
 * (fail-open) e não é cacheado.
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
