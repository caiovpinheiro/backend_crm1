/**
 * POST /api/auth/tenant-lookup — superfície de enumeração reduzida
 * (pentest out/2026): resposta mínima, limite por IP E por e-mail com 429
 * uniforme, tempo igual para e-mail cadastrado × não cadastrado e modo
 * estrito (`TENANT_LOOKUP_STRICT`). Sem DB/Redis: mocka prisma-base e
 * rate-limit; tempo com timers falsos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, withRateLimit } = vi.hoisted(() => ({
  findMany: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findMany } },
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "203.0.113.10",
  hashRateLimitId: (v: string) => `hash(${v})`,
  withRateLimit,
}));

import { POST } from "@/app/api/auth/tenant-lookup/route";

const FLOOR_MS = 300;

function req(email: string): Request {
  return new Request("https://api.test/api/auth/tenant-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

/** Resolve `value` depois de `ms` (tempo falso) — simula a latência do banco. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Dispara o POST e devolve em que instante (ms falsos) a resposta saiu. */
async function timed(email: string): Promise<{ res: Response; elapsedMs: number }> {
  const start = Date.now();
  let res: Response | null = null;
  let elapsedMs = -1;
  const pending = POST(req(email)).then((r) => {
    res = r;
    elapsedMs = Date.now() - start;
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await pending;
  return { res: res as unknown as Response, elapsedMs };
}

const ORG_A = { slug: "acme", status: "ACTIVE" };
const ORG_B = { slug: "beta", status: "ACTIVE" };
const ORG_OFF = { slug: "velha", status: "SUSPENDED" };

const savedEnv = {
  strict: process.env.TENANT_LOOKUP_STRICT,
  floor: process.env.AUTH_MIN_RESPONSE_MS,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  delete process.env.TENANT_LOOKUP_STRICT;
  delete process.env.AUTH_MIN_RESPONSE_MS;
  withRateLimit.mockResolvedValue({ ok: true, headers: {} });
});

afterEach(() => {
  vi.useRealTimers();
  if (savedEnv.strict === undefined) delete process.env.TENANT_LOOKUP_STRICT;
  else process.env.TENANT_LOOKUP_STRICT = savedEnv.strict;
  if (savedEnv.floor === undefined) delete process.env.AUTH_MIN_RESPONSE_MS;
  else process.env.AUTH_MIN_RESPONSE_MS = savedEnv.floor;
});

describe("POST /api/auth/tenant-lookup — resposta mínima", () => {
  it("1 org ativa: só o slug; sem displayName, sem nome comercial", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: false, organization: ORG_A }]);
    const { res } = await timed("ana@acme.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      slug: "acme",
      apex: false,
      // `name`/`status` só por compatibilidade: repetem o slug / constante.
      orgs: [{ slug: "acme", name: "acme", status: "ACTIVE" }],
    });
    expect(body).not.toHaveProperty("displayName");
  });

  it("não consulta nome do titular nem nome da empresa", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: false, organization: ORG_A }]);
    await timed("ana@acme.com");
    const select = findMany.mock.calls[0]?.[0]?.select;
    expect(select).toEqual({
      isSuperAdmin: true,
      organization: { select: { slug: true, status: true } },
    });
  });

  it("2+ orgs ativas: orgs[] sem slug; nenhum campo além de slug carrega dado", async () => {
    findMany.mockResolvedValue([
      { isSuperAdmin: false, organization: ORG_A },
      { isSuperAdmin: false, organization: ORG_B },
    ]);
    const body = await (await timed("ana@acme.com")).res.json();
    expect(body.ok).toBe(true);
    expect(body.slug).toBeNull();
    for (const org of body.orgs) {
      expect(Object.keys(org).sort()).toEqual(["name", "slug", "status"]);
      expect(org.name).toBe(org.slug);
      expect(org.status).toBe("ACTIVE");
    }
    expect(body.orgs.map((o: { slug: string }) => o.slug)).toEqual(["acme", "beta"]);
  });

  it("org não ativa não é listada (status não vaza): sobra a ativa", async () => {
    findMany.mockResolvedValue([
      { isSuperAdmin: false, organization: ORG_A },
      { isSuperAdmin: false, organization: ORG_OFF },
    ]);
    const body = await (await timed("ana@acme.com")).res.json();
    expect(body.slug).toBe("acme");
    expect(JSON.stringify(body)).not.toContain("velha");
    expect(JSON.stringify(body)).not.toContain("SUSPENDED");
  });

  it("só org não ativa: 404 igual ao de e-mail inexistente", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: false, organization: ORG_OFF }]);
    const off = await timed("ana@velha.com");
    findMany.mockResolvedValue([]);
    const none = await timed("ninguem@nada.com");
    expect(off.res.status).toBe(404);
    expect(none.res.status).toBe(404);
    expect(await off.res.json()).toEqual(await none.res.json());
  });

  it("super-admin sem org: apex=true", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: true, organization: null }]);
    const body = await (await timed("root@eduit.com")).res.json();
    expect(body).toEqual({ ok: true, slug: null, apex: true, orgs: [] });
  });
});

describe("POST /api/auth/tenant-lookup — limites", () => {
  it("consome IP (minuto e hora) e e-mail (hash) antes do banco", async () => {
    findMany.mockResolvedValue([]);
    await timed("X@Y.com");
    expect(withRateLimit).toHaveBeenCalledTimes(3);
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
    // E-mail normalizado e com hash: o endereço cru não vira chave/log.
    expect(withRateLimit.mock.calls[2][0]).toMatchObject({
      profile: "auth.lookup.email",
      scope: "email",
      id: "hash(x@y.com)",
    });
    expect(withRateLimit.mock.invocationCallOrder[2]).toBeLessThan(
      findMany.mock.invocationCallOrder[0],
    );
  });

  it("o limite por e-mail conta igual para cadastrado e não cadastrado", async () => {
    findMany.mockResolvedValue([{ isSuperAdmin: false, organization: ORG_A }]);
    await timed("ana@acme.com");
    findMany.mockResolvedValue([]);
    await timed("ninguem@nada.com");
    const emailCalls = withRateLimit.mock.calls
      .map((c) => c[0])
      .filter((o) => o.profile === "auth.lookup.email");
    expect(emailCalls).toHaveLength(2);
  });

  it("429 uniforme: mesmo corpo e mesmos cabeçalhos seja qual for o limite", async () => {
    const limited = (limit: string) => ({
      ok: false,
      response: new Response(JSON.stringify({ retryAfterSec: 60 }), { status: 429 }),
      headers: {
        "X-RateLimit-Limit": limit,
        "X-RateLimit-Remaining": "0",
        "Retry-After": "60",
      },
    });
    const allowed = { ok: true, headers: {} };
    const scenarios = [
      [limited("10")],
      [allowed, limited("120")],
      [allowed, allowed, limited("10")],
    ];
    const seen: Array<{ status: number; body: string; headers: string }> = [];
    for (const sequence of scenarios) {
      withRateLimit.mockReset();
      for (const step of sequence) withRateLimit.mockResolvedValueOnce(step);
      const { res } = await timed("x@y.com");
      const headers = [...res.headers.entries()]
        .filter(([k]) => k.startsWith("x-ratelimit") || k === "retry-after")
        .sort();
      seen.push({
        status: res.status,
        body: await res.text(),
        headers: JSON.stringify(headers),
      });
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(seen[0].status).toBe(429);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(JSON.parse(seen[0].body)).toEqual({
      ok: false,
      error: "rate_limit_exceeded",
      message: "Muitas tentativas. Tente novamente em alguns minutos.",
    });
    expect(seen[0].headers).toBe(JSON.stringify([["retry-after", "60"]]));
  });

  it("e-mail inválido: 400 sem gastar o limite por e-mail nem tocar no banco", async () => {
    const { res } = await timed("sem-arroba");
    expect(res.status).toBe(400);
    expect(withRateLimit).toHaveBeenCalledTimes(2);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/tenant-lookup — tempo uniforme", () => {
  it("cadastrado × não cadastrado respondem no mesmo instante (piso de latência)", async () => {
    // Banco mais lento quando acha linha (120 ms) do que quando não acha (15 ms).
    findMany.mockImplementation(() =>
      after(120, [{ isSuperAdmin: false, organization: ORG_A }]),
    );
    const existing = await timed("ana@acme.com");
    findMany.mockImplementation(() => after(15, []));
    const missing = await timed("ninguem@nada.com");

    expect(existing.res.status).toBe(200);
    expect(missing.res.status).toBe(404);
    expect(existing.elapsedMs).toBe(FLOOR_MS);
    expect(missing.elapsedMs).toBe(FLOOR_MS);
  });

  it("AUTH_MIN_RESPONSE_MS ajusta o piso; 0 desliga", async () => {
    findMany.mockImplementation(() => after(15, []));
    process.env.AUTH_MIN_RESPONSE_MS = "800";
    expect((await timed("a@b.com")).elapsedMs).toBe(800);
    process.env.AUTH_MIN_RESPONSE_MS = "0";
    expect((await timed("a@b.com")).elapsedMs).toBe(15);
  });
});

describe("POST /api/auth/tenant-lookup — TENANT_LOOKUP_STRICT", () => {
  it("resposta idêntica para qualquer e-mail, sem consultar o banco", async () => {
    process.env.TENANT_LOOKUP_STRICT = "true";
    findMany.mockResolvedValue([{ isSuperAdmin: false, organization: ORG_A }]);
    const a = await timed("ana@acme.com");
    const b = await timed("ninguem@nada.com");
    expect(findMany).not.toHaveBeenCalled();
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    const bodyA = await a.res.text();
    expect(bodyA).toBe(await b.res.text());
    expect(JSON.parse(bodyA)).toEqual({ ok: true, slug: null, apex: true, orgs: [] });
    expect(a.elapsedMs).toBe(FLOOR_MS);
    expect(b.elapsedMs).toBe(FLOOR_MS);
  });

  it("continua aplicando os três limites", async () => {
    process.env.TENANT_LOOKUP_STRICT = "1";
    await timed("ana@acme.com");
    expect(withRateLimit).toHaveBeenCalledTimes(3);
  });

  it("desligado por padrão e para valores que não sejam true/1", async () => {
    findMany.mockResolvedValue([]);
    process.env.TENANT_LOOKUP_STRICT = "false";
    expect((await timed("a@b.com")).res.status).toBe(404);
    delete process.env.TENANT_LOOKUP_STRICT;
    expect((await timed("a@b.com")).res.status).toBe(404);
  });
});
