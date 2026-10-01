/**
 * Pentest (vuln-0004): `/api/health` público devolvia estado e latência de
 * Postgres/Redis e o uptime. Agora só o estado agregado sai sem credencial.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  auth: vi.fn(),
  ping: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("ioredis", () => ({
  default: class {
    status = "ready";
    on() {
      return this;
    }
    connect() {
      return Promise.resolve();
    }
    ping() {
      return mocks.ping();
    }
  },
}));

import { resetHealthMemoForTests } from "@/lib/health-check";

import { GET as GET_PAGE } from "../../health/route";
import { GET, HEAD } from "./route";

const savedEnv = { ...process.env };

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://api.bwipo.com/api/health", { headers });
}

beforeEach(() => {
  process.env.REDIS_URL = "redis://fake:6379";
  process.env.HEALTH_TOKEN = "token-do-monitor";
  (globalThis as { healthRedis?: unknown }).healthRedis = undefined;
  resetHealthMemoForTests();
  mocks.queryRaw.mockReset().mockResolvedValue([{ "?column?": 1 }]);
  mocks.ping.mockReset().mockResolvedValue("PONG");
  mocks.auth.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("GET /api/health", () => {
  it("sem credencial: só { status }, 200", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("dependência fora: 503 e { status: degraded }, sem dizer qual nem por quê", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await GET(req());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "degraded" });
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|db|redis|uptime|latency/i);
  });

  it("token errado ou sessão comum: continua só { status }", async () => {
    expect(await (await GET(req({ "x-health-token": "errado" }))).json()).toEqual({
      status: "ok",
    });
    expect(await (await GET(req({ authorization: "Bearer errado" }))).json()).toEqual({
      status: "ok",
    });

    mocks.auth.mockResolvedValue({ user: { id: "u1", isSuperAdmin: false } });
    const res = await GET(req({ cookie: "__Secure-authjs.session-token=abc" }));
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.auth).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["X-Health-Token", { "x-health-token": "token-do-monitor" }],
    ["Authorization: Bearer", { authorization: "Bearer token-do-monitor" }],
  ])("detalhe com HEALTH_TOKEN via %s", async (_label, headers) => {
    const body = await (await GET(req(headers))).json();
    expect(body.status).toBe("ok");
    expect(body.db).toMatchObject({ ok: true });
    expect(body.redis).toMatchObject({ ok: true });
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("commit da imagem (GIT_SHA) só no detalhe protegido", async () => {
    process.env.GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

    const anon = await (await GET(req())).text();
    expect(JSON.parse(anon)).toEqual({ status: "ok" });
    expect(anon).not.toMatch(/gitSha|0123456789abcdef/);

    const detail = await (await GET(req({ "x-health-token": "token-do-monitor" }))).json();
    expect(detail.gitSha).toBe("0123456789abcdef0123456789abcdef01234567");

    delete process.env.GIT_SHA;
    const semSha = await (await GET(req({ "x-health-token": "token-do-monitor" }))).json();
    expect(semSha.gitSha).toBeNull();
  });

  it("detalhe com sessão de super-admin", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u1", isSuperAdmin: true } });
    const body = await (
      await GET(req({ cookie: "__Secure-authjs.session-token=abc" }))
    ).json();
    expect(body.db).toMatchObject({ ok: true });
  });

  it("sem HEALTH_TOKEN configurado, header vazio ou qualquer valor não libera", async () => {
    delete process.env.HEALTH_TOKEN;
    expect(await (await GET(req({ "x-health-token": "" }))).json()).toEqual({ status: "ok" });
    expect(await (await GET(req({ "x-health-token": "x" }))).json()).toEqual({ status: "ok" });
  });

  it("rajada anônima reaproveita a checagem (não vira carga no banco)", async () => {
    await Promise.all(Array.from({ length: 20 }, () => GET(req())));
    await GET(req());
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("HEAD mantém 200/503 (healthcheck do compose usa só o status)", async () => {
    expect((await HEAD()).status).toBe(200);
    resetHealthMemoForTests();
    mocks.ping.mockRejectedValue(new Error("redis fora"));
    expect((await HEAD()).status).toBe(503);
  });
});

describe("GET /health (HTML)", () => {
  const pageReq = (headers: Record<string, string> = {}) =>
    new Request("https://api.bwipo.com/health", { headers });

  it("pública: só o estado agregado, sem Postgres/Redis/uptime nem nome do produto", async () => {
    const res = await GET_PAGE(pageReq());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Operacional");
    expect(html).not.toMatch(/Postgres|Redis|Uptime|CRM EduIT/);
  });

  it("com token: mostra o detalhe", async () => {
    const html = await (
      await GET_PAGE(pageReq({ "x-health-token": "token-do-monitor" }))
    ).text();
    expect(html).toMatch(/Postgres/);
    expect(html).toMatch(/Uptime/);
  });
});
