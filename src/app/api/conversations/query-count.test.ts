/**
 * P-10 — quantas consultas e idas ao Redis custam abrir uma conversa
 * (`GET /api/conversations/:id/messages`) e os pré-checks da lista do inbox
 * (`GET /api/conversations`), e em quantas fases.
 *
 * Mede com o cliente Prisma espião e o Redis falso de
 * `@/test-setup/io-probe` (relógio falso: o resultado não depende da
 * máquina). A autenticação (JWT + rate limit) fica fora da conta: o que se
 * mede é do `runWithContext` para dentro. Na lista, a listagem em si
 * (`getConversations` / `getTabCounts`) é substituída por um stub — o alvo
 * são os pré-checks de autorização que rodam antes dela.
 *
 * Cache "quente" = segunda requisição, com authz/flags/settings/grants já
 * no Redis (o estado normal em produção).
 */
import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.FEATURE_FLAG_RBAC_GRANULAR_SCOPE_V1;
  return {
    session: null as unknown,
    getConversations: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    getTabCounts: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  };
});

vi.mock("@/lib/prisma-base", async () => {
  const { probe } = await import("@/test-setup/io-probe");
  return {
    prismaBase: probe.prisma,
    isPgPoolTimeoutError: () => false,
    withPgPoolRetry: (fn: () => unknown) => fn(),
  };
});
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  const { probe } = await import("@/test-setup/io-probe");
  const { getRequestContext } = await import("@/lib/request-context");
  const { SCOPED_FIXTURE_MODELS } = await import("@/test-setup/inbox-fixture");
  return { ...actual, prisma: probe.scoped(SCOPED_FIXTURE_MODELS, getRequestContext) };
});
vi.mock("ioredis", async () => {
  const { probe } = await import("@/test-setup/io-probe");
  return { default: probe.FakeRedis };
});
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  enforceSessionApiRateLimit: async () => null,
}));
vi.mock("@/lib/org-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/org-rate-limit")>()),
  enforceOrgApiRateLimit: async () => null,
}));
vi.mock("@/lib/api-access-audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-access-audit")>()),
  logApiAccessCompleted: async () => undefined,
  logApiAccessAuthReject: () => undefined,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/conversations")>();
  h.getConversations = vi.fn(async () => ({ items: [], total: 0, page: 1, perPage: 30 }));
  h.getTabCounts = vi.fn(async () => ({}));
  return { ...actual, getConversations: h.getConversations, getTabCounts: h.getTabCounts };
});

import { GET as getMessages } from "@/app/api/conversations/[id]/messages/route";
import { GET as getInbox } from "@/app/api/conversations/route";
import { cache } from "@/lib/cache";
import {
  CONV,
  seedInbox,
  sessionFor,
  type FixtureUserKey,
  type SeedOptions,
} from "@/test-setup/inbox-fixture";
import { describeStats, probe, type IoEntry } from "@/test-setup/io-probe";

const QUEUE_PERMS = [
  "conversation:view",
  "conversation:reply",
  "conversation:claim",
  "inbox:tab:entrada",
];

/** Canal por papel: o operador só vê `ch_1`. */
const CHANNEL_GRANTS = { channel: { view: { roles: { role_member: ["ch_1"] } } } };

async function clearCaches() {
  await cache.delPattern("*");
}

function setup(user: FixtureUserKey, seed: SeedOptions = {}) {
  const db = seedInbox(seed);
  probe.setDbHandler((model, operation, args) => db.run(model, operation, args));
  h.session = sessionFor(user);
  return db;
}

async function openConversation(id: string, query = "") {
  const run = await probe.run(() =>
    getMessages(new Request(`http://localhost/api/conversations/${id}/messages${query}`), {
      params: Promise.resolve({ id }),
    }),
  );
  const res = run.result as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, entries: run.entries };
}

async function listInbox(query = "") {
  const run = await probe.run(() =>
    getInbox(new Request(`http://localhost/api/conversations${query}`)),
  );
  const res = run.result as Response;
  return { status: res.status, entries: run.entries };
}

function measure(name: string, entries: IoEntry[]) {
  const pg = probe.stats("pg", entries);
  const redis = probe.stats("redis", entries);
  // `P10_REPORT=<arquivo>` grava o detalhamento por fase (usado no PR).
  if (process.env.P10_REPORT) {
    appendFileSync(process.env.P10_REPORT, `${describeStats(name, pg, redis)}\n\n`);
  }
  return { pg, redis };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  probe.reset();
  await probe.run(clearCaches);
  probe.reset();
});

describe("GET /api/conversations/:id/messages — consultas por fase", () => {
  it("operador abre a própria conversa (flag de escopo desligada)", async () => {
    setup("member");
    const cold = await openConversation(CONV.mine);
    expect(cold.status).toBe(200);
    const warm = await openConversation(CONV.mine);
    expect(warm.status).toBe(200);
    expect((warm.body.messages as unknown[]).length).toBe(6);
    expect(warm.body.canReply).toBe(true);
    expect(warm.body.hasOlderTickets).toBe(true);
    expect(warm.body.pinnedMessageIds).toEqual(["wamid.m2"]);

    const { pg, redis } = measure("messages / operador, conversa própria, flag off", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 12,
      fases: 6,
      redis: 2,
      redisEmSerie: 2,
    });
  });

  it("operador abre a própria conversa (flag de escopo ligada, canal por papel)", async () => {
    setup("member", { rbacFlag: true, scopeGrants: CHANNEL_GRANTS });
    await openConversation(CONV.mine);
    const warm = await openConversation(CONV.mine);
    expect(warm.status).toBe(200);
    expect(warm.body.canReply).toBe(true);

    const { pg, redis } = measure("messages / operador, conversa própria, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 13,
      fases: 6,
      redis: 3,
      redisEmSerie: 3,
    });
  });

  it("operador abre conversa da fila (sem responsável), flag ligada", async () => {
    setup("member", {
      rbacFlag: true,
      scopeGrants: CHANNEL_GRANTS,
      memberPermissions: QUEUE_PERMS,
      settings: { "unassigned.MEMBER": "true" },
    });
    await openConversation(CONV.queue);
    const warm = await openConversation(CONV.queue);
    expect(warm.status).toBe(200);

    const { pg, redis } = measure("messages / operador, conversa da fila, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 17,
      fases: 10,
      redis: 8,
      redisEmSerie: 6,
    });
  });

  it("gestor abre conversa de outro agente, flag ligada", async () => {
    setup("manager", { rbacFlag: true, scopeGrants: CHANNEL_GRANTS });
    await openConversation(CONV.others);
    const warm = await openConversation(CONV.others);
    expect(warm.status).toBe(200);

    const { pg, redis } = measure("messages / gestor, conversa de outro, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 17,
      fases: 10,
      redis: 9,
      redisEmSerie: 6,
    });
  });

  it("admin abre conversa de outro agente, flag ligada", async () => {
    setup("admin", { rbacFlag: true, scopeGrants: CHANNEL_GRANTS });
    await openConversation(CONV.others);
    const warm = await openConversation(CONV.others);
    expect(warm.status).toBe(200);

    const { pg, redis } = measure("messages / admin, conversa de outro, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 14,
      fases: 8,
      redis: 7,
      redisEmSerie: 6,
    });
  });
});

describe("GET /api/conversations — pré-checks antes da listagem", () => {
  it("operador, flag ligada", async () => {
    setup("member", { rbacFlag: true, scopeGrants: CHANNEL_GRANTS, memberPermissions: QUEUE_PERMS });
    await listInbox("?tab=entrada");
    h.getConversations.mockClear();
    const warm = await listInbox("?tab=entrada");
    expect(warm.status).toBe(200);
    expect(h.getConversations).toHaveBeenCalledTimes(1);
    expect(h.getConversations.mock.calls[0]![0]).toMatchObject({ allowedChannelIds: ["ch_1"] });

    const { pg, redis } = measure("inbox / operador, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 2,
      fases: 1,
      redis: 5,
      redisEmSerie: 1,
    });
  });

  it("gestor em modo own (visibility.MANAGER=own), flag ligada", async () => {
    setup("manager", {
      rbacFlag: true,
      scopeGrants: CHANNEL_GRANTS,
      settings: { "visibility.MANAGER": "own" },
    });
    await listInbox("?tab=esperando");
    const warm = await listInbox("?tab=esperando");
    expect(warm.status).toBe(200);

    const { pg, redis } = measure("inbox / gestor own, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 2,
      fases: 1,
      redis: 5,
      redisEmSerie: 1,
    });
  });

  it("contadores (?counts=1), operador, flag ligada", async () => {
    setup("member", { rbacFlag: true, scopeGrants: CHANNEL_GRANTS, memberPermissions: QUEUE_PERMS });
    await listInbox("?counts=1");
    h.getTabCounts.mockClear();
    const warm = await listInbox("?counts=1");
    expect(warm.status).toBe(200);
    expect(h.getTabCounts).toHaveBeenCalledTimes(1);

    const { pg, redis } = measure("inbox counts / operador, flag on", warm.entries);
    expect({ consultas: pg.count, fases: pg.phases, redis: redis.count, redisEmSerie: redis.phases }).toEqual({
      consultas: 2,
      fases: 1,
      redis: 5,
      redisEmSerie: 1,
    });
  });
});
