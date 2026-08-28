/**
 * Testes do cache curto do GET /api/organization/by-slug.
 * Sem DB/Redis: mocka rate-limit, prisma-base e o módulo de cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, cacheGet, cacheSet, withRateLimit } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { organization: { findUnique } },
}));

vi.mock("@/lib/cache", () => ({
  cache: { get: cacheGet, set: cacheSet },
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "203.0.113.10",
  withRateLimit,
}));

import { GET } from "@/app/api/organization/by-slug/route";

function req(slug: string): Request {
  return new Request(`https://api.test/api/organization/by-slug?slug=${slug}`);
}

const ORG = { slug: "acme", name: "Acme", status: "ACTIVE" };

describe("GET /api/organization/by-slug — cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withRateLimit.mockResolvedValue({ ok: true, headers: {} });
    cacheGet.mockResolvedValue(undefined);
    cacheSet.mockResolvedValue(undefined);
    findUnique.mockResolvedValue(ORG);
  });

  it("1ª chamada: consulta o banco, responde 200 e grava no cache", async () => {
    const res = await GET(req("acme"));
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledWith(
      "org_active_slug:acme",
      { slug: "acme", name: "Acme" },
      60,
    );
  });

  it("cache hit: responde 200 SEM tocar no banco", async () => {
    cacheGet.mockResolvedValue({ slug: "acme", name: "Acme" });
    const res = await GET(req("acme"));
    expect(res.status).toBe(200);
    expect(findUnique).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("slug inexistente: 404 e NÃO grava no cache", async () => {
    findUnique.mockResolvedValue(null);
    const res = await GET(req("sumiu"));
    expect(res.status).toBe(404);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("org suspensa: 404 e NÃO grava no cache", async () => {
    findUnique.mockResolvedValue({ ...ORG, status: "SUSPENDED" });
    const res = await GET(req("acme"));
    expect(res.status).toBe(404);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("slug malformado: 400 sem tocar no banco nem no cache", async () => {
    const res = await GET(req("INVALID_SLUG!!"));
    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
  });
});
