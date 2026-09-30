/**
 * SEC-11: POST /api/auth/tenant-lookup nao devolve dado pessoal do titular
 * (`displayName`/`name`) e passa por duas janelas de rate-limit por IP.
 * Sem DB/Redis: mocka prisma-base e rate-limit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, withRateLimit } = vi.hoisted(() => ({
  findMany: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findMany } },
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "203.0.113.10",
  withRateLimit,
}));

import { POST } from "@/app/api/auth/tenant-lookup/route";

function req(email: string): Request {
  return new Request("https://api.test/api/auth/tenant-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

const ORG_A = { slug: "acme", name: "Acme", status: "ACTIVE" };
const ORG_B = { slug: "beta", name: "Beta", status: "ACTIVE" };

describe("POST /api/auth/tenant-lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withRateLimit.mockResolvedValue({ ok: true, headers: {} });
  });

  it("consulta so isSuperAdmin + organization (sem name) e responde sem displayName", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: false, organization: ORG_A }]);
    const res = await POST(req("ana@acme.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, slug: "acme", apex: false, orgs: [ORG_A] });
    expect(body).not.toHaveProperty("displayName");
    const select = findMany.mock.calls[0]?.[0]?.select;
    expect(select).not.toHaveProperty("name");
    expect(JSON.stringify(body)).not.toContain("name\":\"Ana");
  });

  it("2+ orgs: devolve orgs[] sem slug e sem displayName", async () => {
    findMany.mockResolvedValue([
      { isSuperAdmin: false, organization: ORG_A },
      { isSuperAdmin: false, organization: ORG_B },
    ]);
    const body = await (await POST(req("ana@acme.com"))).json();
    expect(body).toEqual({ ok: true, slug: null, apex: false, orgs: [ORG_A, ORG_B] });
  });

  it("super-admin sem org: apex=true sem displayName", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: true, organization: null }]);
    const body = await (await POST(req("root@eduit.com"))).json();
    expect(body).toEqual({ ok: true, slug: null, apex: true, orgs: [] });
  });

  it("aplica as duas janelas (auth.public e auth.lookup.hourly) por IP", async () => {
    findMany.mockResolvedValue([]);
    await POST(req("x@y.com"));
    expect(withRateLimit).toHaveBeenCalledTimes(2);
    expect(withRateLimit.mock.calls[0][0]).toMatchObject({
      profile: "auth.public",
      scope: "ip",
      id: "203.0.113.10",
    });
    expect(withRateLimit.mock.calls[1][0]).toMatchObject({
      profile: "auth.lookup.hourly",
      scope: "ip",
      id: "203.0.113.10",
    });
  });

  it("janela horaria estourada: 429 sem tocar no banco", async () => {
    const response = new Response("{}", { status: 429 });
    withRateLimit
      .mockResolvedValueOnce({ ok: true, headers: {} })
      .mockResolvedValueOnce({ ok: false, response, headers: {} });
    const res = await POST(req("x@y.com"));
    expect(res.status).toBe(429);
    expect(findMany).not.toHaveBeenCalled();
  });
});
