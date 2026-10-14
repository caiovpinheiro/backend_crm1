/**
 * Classes de custo (`api-cost-class.ts`) e limite por classe
 * (`api-cost-limit.ts`): mapa de rotas, token bucket com refill contínuo,
 * 429 curto só na classe, sem bloqueio de 60 s, fail-open e log amostrado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyApiRequest, hasSearchParam, type ApiCostClass } from "@/lib/api-cost-class";
import {
  API_COST_RETRY_MAX_MS,
  API_COST_RETRY_MIN_MS,
  apiCostBucketKey,
  clampRetryAfterMs,
  consumeApiCostToken,
  enforceApiCostLimits,
  getApiCostBucketConfig,
  resetApiCostLimitForTests,
} from "@/lib/api-cost-limit";
import { metrics } from "@/lib/metrics";

const ENV_KEYS = [
  "API_COST_LIMIT_DISABLED",
  "API_COST_CACHED_READ_PER_MIN",
  "SESSION_RATE_LIMIT_RPM",
  "API_COST_HEAVY_CAPACITY",
  "API_COST_HEAVY_REFILL_PER_SEC",
  "API_COST_ACCESSORY_CAPACITY",
  "API_COST_ACCESSORY_REFILL_PER_SEC",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let clock = 1_000_000;
const emitted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  clock = 1_000_000;
  emitted.length = 0;
  resetApiCostLimitForTests({
    redis: null,
    now: () => clock,
    emit: (obj) => emitted.push(obj),
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetApiCostLimitForTests();
});

function call(method: string, path: string, userId = "u1", hasSearch = false) {
  return enforceApiCostLimits({
    userId,
    organizationId: "org1",
    cls: classifyApiRequest({ method, path, hasSearch }),
    method,
    path,
  });
}

describe("classifyApiRequest — mapa central", () => {
  const cases: Array<[string, string, ApiCostClass]> = [
    // (a) envio de mensagem em todas as formas, anexos, mover, salvar, auth
    ["POST", "/api/conversations/c1/messages", "essential"],
    ["POST", "/api/conversations/123/attachments", "essential"],
    ["POST", "/api/conversations/c1/template", "essential"],
    ["POST", "/api/conversations/c1/products", "essential"],
    ["POST", "/api/conversations/c1/forward", "essential"],
    ["POST", "/api/conversations/create", "essential"],
    ["POST", "/api/deals/d1/messages", "essential"],
    ["POST", "/api/whatsapp-groups/g1/messages", "essential"],
    ["POST", "/api/messages/m1/reactions", "essential"],
    ["POST", "/api/deals/d1/move", "essential"],
    ["PATCH", "/api/deals/d1", "essential"],
    ["PUT", "/api/contacts/c1", "essential"],
    ["DELETE", "/api/deals/d1/tags", "essential"],
    ["POST", "/api/uploads/automation-media", "essential"],
    ["GET", "/api/storage/org/inbox/a.jpg", "essential"],
    ["GET", "/api/uploads/x/y.pdf", "essential"],
    ["GET", "/api/media/proxy", "essential"],
    ["GET", "/api/auth/session", "essential"],
    ["POST", "/api/auth/callback/credentials", "essential"],
    ["POST", "/api/auth/signout", "essential"],
    ["PUT", "/api/agents/u1/status", "essential"],
    ["POST", "/api/agents/me/activity", "essential"],
    // (b) leitura comum fora do mapa
    ["GET", "/api/settings/channels", "cached_read"],
    ["GET", "/api/me/bootstrap", "cached_read"],
    ["GET", "/api/conversations", "cached_read"],
    ["HEAD", "/api/pipelines", "cached_read"],
    // (c) leituras pesadas
    ["GET", "/api/pipelines/p1/board", "heavy_read"],
    ["GET", "/api/contacts/c1", "heavy_read"],
    ["GET", "/api/conversations/c1/calling-context", "heavy_read"],
    ["GET", "/api/scheduled-messages", "heavy_read"],
    ["GET", "/api/conversations/c1/messages", "heavy_read"],
    ["GET", "/api/deals/d1", "heavy_read"],
    // (d) acessórias
    ["POST", "/api/presence/beat", "accessory"],
    ["POST", "/api/presence/heartbeat", "accessory"],
    ["POST", "/api/agents/me/ping", "accessory"],
    ["POST", "/api/conversations/c1/typing", "accessory"],
    ["GET", "/api/activities/alerts", "accessory"],
    ["GET", "/api/agents/u1/status", "accessory"],
  ];
  it.each(cases)("%s %s → %s", (method, path, cls) => {
    expect(classifyApiRequest({ method, path })).toBe(cls);
  });

  it("busca (`search`/`q` preenchido) faz qualquer GET virar leitura pesada", () => {
    expect(hasSearchParam("?search=ana")).toBe(true);
    expect(hasSearchParam(new URLSearchParams("q=11999"))).toBe(true);
    expect(hasSearchParam("?search=&q=  ")).toBe(false);
    expect(classifyApiRequest({ method: "GET", path: "/api/contacts", hasSearch: true })).toBe(
      "heavy_read",
    );
    // Envio continua essencial mesmo com query de busca.
    expect(
      classifyApiRequest({ method: "POST", path: "/api/conversations/c1/messages", hasSearch: true }),
    ).toBe("essential");
  });

  it("escrita fora do mapa é essencial; sem método/rota também", () => {
    expect(classifyApiRequest({ method: "POST", path: "/api/qualquer/coisa" })).toBe("essential");
    expect(classifyApiRequest({ method: "DELETE", path: "/api/x/1" })).toBe("essential");
    expect(classifyApiRequest({})).toBe("essential");
    expect(classifyApiRequest({ method: "GET" })).toBe("essential");
  });
});

describe("envio de mensagem nunca recebe 429", () => {
  it("1000 envios seguidos com todos os limites no mínimo", async () => {
    process.env.API_COST_CACHED_READ_PER_MIN = "1";
    process.env.API_COST_HEAVY_CAPACITY = "1";
    process.env.API_COST_ACCESSORY_CAPACITY = "1";
    for (let i = 0; i < 1000; i++) {
      expect(await call("POST", "/api/conversations/c1/messages")).toBeNull();
      expect(await call("POST", `/api/conversations/c${i}/attachments`)).toBeNull();
    }
  });
});

describe("token bucket com refill contínuo", () => {
  const config = { capacity: 3, refillPerSec: 1 };
  const take = () => consumeApiCostToken({ cls: "heavy_read", userId: "u1", config });

  it("gasta a capacidade, depois só o que foi reposto (proporcional ao tempo)", async () => {
    for (let i = 0; i < 3; i++) expect((await take()).allowed).toBe(true);
    const denied = await take();
    expect(denied.allowed).toBe(false);
    expect(denied.waitMs).toBe(1000);

    clock += 500; // meio token: ainda não cabe
    const half = await take();
    expect(half.allowed).toBe(false);
    expect(half.waitMs).toBe(500);

    clock += 500; // completou 1 token
    expect((await take()).allowed).toBe(true);
    expect((await take()).allowed).toBe(false);

    clock += 10_000; // enche, mas nunca passa da capacidade
    for (let i = 0; i < 3; i++) expect((await take()).allowed).toBe(true);
    expect((await take()).allowed).toBe(false);
  });

  it("buckets separados por usuário e por classe", async () => {
    for (let i = 0; i < 3; i++) await take();
    expect((await take()).allowed).toBe(false);
    expect((await consumeApiCostToken({ cls: "heavy_read", userId: "u2", config })).allowed).toBe(true);
    expect((await consumeApiCostToken({ cls: "accessory", userId: "u1", config })).allowed).toBe(true);
  });

  it("Redis: script com capacidade, taxa por ms, agora e custo; lê a resposta", async () => {
    const evalFn = vi.fn().mockResolvedValue([0, 1500, 0]);
    resetApiCostLimitForTests({ redis: { eval: evalFn, set: vi.fn() }, now: () => clock });
    const d = await take();
    expect(d).toEqual({ allowed: false, remaining: 0, waitMs: 1500, store: "redis" });
    const args = evalFn.mock.calls[0];
    expect(args[1]).toBe(1);
    expect(args[2]).toBe(apiCostBucketKey("heavy_read", "u1"));
    expect(args.slice(3)).toEqual(["3", "0.001", String(clock), "1"]);
  });

  it("Redis com erro → fail-open (deixa passar)", async () => {
    resetApiCostLimitForTests({
      redis: { eval: vi.fn().mockRejectedValue(new Error("Connection is closed")), set: vi.fn() },
      now: () => clock,
    });
    const d = await take();
    expect(d.allowed).toBe(true);
    expect(d.store).toBe("fail-open");
  });
});

describe("429 curto só na classe", () => {
  it("corpo { retryAfterMs, class }, retryAfterMs entre 2 e 5 s, Retry-After", async () => {
    process.env.API_COST_HEAVY_CAPACITY = "2";
    process.env.API_COST_HEAVY_REFILL_PER_SEC = "2";
    expect(await call("GET", "/api/deals/d1")).toBeNull();
    expect(await call("GET", "/api/deals/d2")).toBeNull();
    const res = await call("GET", "/api/deals/d3");
    expect(res?.status).toBe(429);
    const body = await res!.json();
    expect(body).toMatchObject({ code: "RATE_LIMITED", class: "heavy_read" });
    // Faltava 0,5 s de refill → sobe para o piso de 2 s.
    expect(body.retryAfterMs).toBe(API_COST_RETRY_MIN_MS);
    expect(res!.headers.get("Retry-After")).toBe("2");

    // As outras classes do mesmo usuário seguem livres.
    expect(await call("GET", "/api/settings/channels")).toBeNull();
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    expect(await call("POST", "/api/conversations/c1/messages")).toBeNull();
    expect(await call("PATCH", "/api/deals/d1")).toBeNull();
  });

  it("espera longa é limitada a 5 s", async () => {
    process.env.API_COST_ACCESSORY_CAPACITY = "1";
    process.env.API_COST_ACCESSORY_REFILL_PER_SEC = "0.01"; // 100 s por token
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    const res = await call("POST", "/api/agents/me/ping");
    expect(res?.status).toBe(429);
    const body = await res!.json();
    expect(body.retryAfterMs).toBe(API_COST_RETRY_MAX_MS);
    expect(body.class).toBe("accessory");
    expect(res!.headers.get("Retry-After")).toBe("5");
  });

  it("clampRetryAfterMs", () => {
    expect(clampRetryAfterMs(1)).toBe(2000);
    expect(clampRetryAfterMs(3456.2)).toBe(3457);
    expect(clampRetryAfterMs(60_000)).toBe(5000);
    expect(clampRetryAfterMs(Number.NaN)).toBe(5000);
  });

  it("conta na métrica crm_api_cost_rejections_total{class,status}", async () => {
    process.env.API_COST_HEAVY_CAPACITY = "1";
    const before =
      (await metrics.apiCost.rejections.get()).values.find(
        (v) => v.labels.class === "heavy_read" && v.labels.status === "429",
      )?.value ?? 0;
    await call("GET", "/api/contacts/c1");
    await call("GET", "/api/contacts/c1");
    const after =
      (await metrics.apiCost.rejections.get()).values.find(
        (v) => v.labels.class === "heavy_read" && v.labels.status === "429",
      )?.value ?? 0;
    expect(after - before).toBe(1);
  });

  it("API_COST_LIMIT_DISABLED=1 desliga os 429", async () => {
    process.env.API_COST_HEAVY_CAPACITY = "1";
    process.env.API_COST_LIMIT_DISABLED = "1";
    for (let i = 0; i < 5; i++) expect(await call("GET", "/api/deals/d1")).toBeNull();
  });
});

describe("sem bloqueio de 60 s", () => {
  it("rajada de 73 GETs de deals distintos em 66 s não recusa nada nem trava outras classes", async () => {
    for (let i = 0; i < 73; i++) {
      // 73 pedidos espalhados por 66 s (~1,1/s, abaixo do refill de 2/s).
      clock += Math.round((66_000 / 73) * (i === 0 ? 0 : 1));
      expect(await call("GET", `/api/deals/deal-${i}`)).toBeNull();
      expect(await call("GET", "/api/settings/channels")).toBeNull();
      expect(await call("POST", "/api/conversations/c1/messages")).toBeNull();
    }
  });

  it("mesmo estourando a classe pesada de uma vez, volta em segundos (não em 60 s)", async () => {
    let rejected = 0;
    for (let i = 0; i < 73; i++) {
      if (await call("GET", `/api/deals/deal-${i}`)) rejected += 1;
    }
    // 60 de capacidade; o resto recusado só na classe.
    expect(rejected).toBe(13);
    expect(await call("GET", "/api/settings/channels")).toBeNull();
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    expect(await call("POST", "/api/conversations/c1/messages")).toBeNull();
    clock += 1_000; // 2 tokens repostos
    expect(await call("GET", "/api/deals/outro")).toBeNull();
    expect(await call("GET", "/api/deals/outro-2")).toBeNull();
  });
});

describe("configuração", () => {
  it("padrões e alias SESSION_RATE_LIMIT_RPM da classe de leituras comuns", () => {
    expect(getApiCostBucketConfig("essential")).toBeNull();
    expect(getApiCostBucketConfig("cached_read")).toEqual({ capacity: 1200, refillPerSec: 20 });
    expect(getApiCostBucketConfig("heavy_read")).toEqual({ capacity: 60, refillPerSec: 2 });
    expect(getApiCostBucketConfig("accessory")).toEqual({ capacity: 30, refillPerSec: 1 });
    expect(getApiCostBucketConfig("cached_read", { SESSION_RATE_LIMIT_RPM: "600" })).toEqual({
      capacity: 600,
      refillPerSec: 10,
    });
    expect(
      getApiCostBucketConfig("cached_read", {
        SESSION_RATE_LIMIT_RPM: "600",
        API_COST_CACHED_READ_PER_MIN: "2400",
      }),
    ).toEqual({ capacity: 2400, refillPerSec: 40 });
    expect(getApiCostBucketConfig("heavy_read", { API_COST_HEAVY_CAPACITY: "abc" })).toEqual({
      capacity: 60,
      refillPerSec: 2,
    });
  });
});

describe("log de rejeição amostrado", () => {
  it("no máximo 1 por usuário+classe por minuto, com userId, classe e rota", async () => {
    process.env.API_COST_HEAVY_CAPACITY = "1";
    process.env.API_COST_HEAVY_REFILL_PER_SEC = "0.001";
    process.env.API_COST_ACCESSORY_CAPACITY = "1";
    process.env.API_COST_ACCESSORY_REFILL_PER_SEC = "0.001";
    for (let i = 0; i < 20; i++) await call("GET", `/api/deals/d${i}`);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: "api_cost_rejected",
      userId: "u1",
      organizationId: "org1",
      class: "heavy_read",
      route: "/api/deals/d1",
      method: "GET",
      status: 429,
      suppressed: 0,
    });

    // Outra classe do mesmo usuário e outro usuário logam à parte.
    await call("POST", "/api/agents/me/ping");
    await call("POST", "/api/agents/me/ping");
    await call("GET", "/api/deals/x", "u2");
    await call("GET", "/api/deals/y", "u2");
    expect(emitted.map((e) => `${e.userId}:${e.class}`)).toEqual([
      "u1:heavy_read",
      "u1:accessory",
      "u2:heavy_read",
    ]);

    clock += 60_000;
    await call("GET", "/api/deals/z");
    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toMatchObject({ userId: "u1", class: "heavy_read", suppressed: 18 });
  });
});

describe("cobrança única por requisição", () => {
  it("o mesmo objeto de requisição passando 2× pelo requireAuth cobra 1×", async () => {
    process.env.API_COST_HEAVY_CAPACITY = "1";
    const token = {};
    const args = { userId: "u1", cls: "heavy_read" as const, requestToken: token };
    expect(await enforceApiCostLimits(args)).toBeNull();
    expect(await enforceApiCostLimits(args)).toBeNull();
    expect(await enforceApiCostLimits({ ...args, requestToken: {} })).not.toBeNull();
  });
});
