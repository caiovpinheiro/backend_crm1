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
 * "Consulta" = chamada ao cliente Prisma. Cache "quente" = segunda
 * requisição, com authz/flags/settings/grants já no Redis (o estado normal
 * em produção).
 *
 * Três blocos:
 *   1. contagem por fase (`ANTES` guarda o que a mesma medição dava antes
 *      da deduplicação; o teste trava o "depois");
 *   2. contrato da resposta — snapshots gravados com o handler ANTIGO;
 *   3. autorização negativa pelo caminho novo: mesmo 404, e nada da
 *      conversa é lido antes do veredito.
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
vi.mock("@/lib/debug-log", () => ({ debugLog: () => undefined }));
vi.mock("@/services/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/conversations")>();
  h.getConversations = vi.fn(async () => ({ items: [], total: 0, page: 1, perPage: 30 }));
  h.getTabCounts = vi.fn(async () => ({}));
  return { ...actual, getConversations: h.getConversations, getTabCounts: h.getTabCounts };
});

import { GET as getMessages } from "@/app/api/conversations/[id]/messages/route";
import { GET as getInbox } from "@/app/api/conversations/route";
import { cache } from "@/lib/cache";
import type { FakeDb } from "@/test-setup/fake-db";
import {
  CONV,
  ORG,
  seedInbox,
  sessionFor,
  USERS,
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

/** Canal por PAPEL: o operador só vê `ch_1`. */
const CHANNEL_BY_ROLE = { channel: { view: { roles: { role_member: ["ch_1"] } } } };
/** Canal por USUÁRIO: o operador só vê `ch_1`. */
const CHANNEL_BY_USER = { channel: { view: { users: { [USERS.member.id]: ["ch_1"] } } } };

type Counts = { consultas: number; fases: number; redis: number; redisEmSerie: number };

/**
 * A mesma medição com os handlers de antes do P-10 (este arquivo rodado
 * contra o código anterior). Fica como registro e como piso: `measure`
 * recusa cenário sem "antes" e qualquer "depois" pior que ele.
 */
const antes = (consultas: number, fases: number, redis: number, redisEmSerie: number): Counts => ({
  consultas,
  fases,
  redis,
  redisEmSerie,
});
const ANTES: Record<string, Counts> = {
  "messages / operador, conversa própria, flag off": antes(12, 6, 2, 2),
  "messages / operador, conversa própria pelo número, flag off": antes(14, 8, 2, 2),
  "messages / operador, conversa própria, flag on (canal por usuário)": antes(13, 6, 3, 3),
  "messages / operador, conversa própria, flag on (canal por papel)": antes(13, 6, 3, 3),
  "messages / gestor, conversa de outro agente, flag off": antes(15, 9, 6, 5),
  "messages / gestor, conversa de outro agente, flag on (canal por papel)": antes(17, 10, 8, 7),
  "messages / admin, conversa de outro agente, flag on": antes(16, 9, 7, 6),
  "messages / operador, conversa da fila, flag off": antes(15, 9, 6, 5),
  "messages / operador, conversa da fila, flag on (canal por papel)": antes(17, 10, 8, 7),
  "messages / operador, página anterior (?before)": antes(11, 6, 2, 2),
  "messages / operador, histórico (?history=1)": antes(11, 8, 2, 2),
  "messages / operador, conversa com extras": antes(15, 9, 2, 2),
  "inbox / operador, flag on": antes(2, 1, 7, 4),
  "inbox / gestor own, flag on": antes(2, 1, 9, 6),
  "inbox counts / operador, flag on": antes(2, 1, 7, 4),
};

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
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    entries: run.entries,
  };
}

/** Segunda requisição (cache quente) — a que é medida. */
async function openWarm(id: string, query = "") {
  await openConversation(id, query);
  return openConversation(id, query);
}

async function listInbox(query = "") {
  const run = await probe.run(() =>
    getInbox(new Request(`http://localhost/api/conversations${query}`)),
  );
  const res = run.result as Response;
  return { status: res.status, entries: run.entries };
}

function measure(name: string, entries: IoEntry[]): Counts {
  const pg = probe.stats("pg", entries);
  const redis = probe.stats("redis", entries);
  // `P10_REPORT=<arquivo>` grava o detalhamento por fase (usado no PR).
  if (process.env.P10_REPORT) {
    appendFileSync(process.env.P10_REPORT, `${describeStats(name, pg, redis)}\n\n`);
  }
  const depois: Counts = {
    consultas: pg.count,
    fases: pg.phases,
    redis: redis.count,
    redisEmSerie: redis.phases,
  };
  const before = ANTES[name];
  expect(before, `sem medição "antes" para: ${name}`).toBeDefined();
  for (const key of Object.keys(depois) as (keyof Counts)[]) {
    expect(depois[key], `${name}: ${key} piorou`).toBeLessThanOrEqual(before![key]);
  }
  return depois;
}

const minutesFromNoon = (min: number) =>
  new Date(Date.parse("2026-09-30T12:00:00.000Z") + min * 60_000);

/** Conversa com tudo que gera consulta condicional na fase 3. */
function addExtras(db: FakeDb) {
  const base = db.table("message").find((m) => m.id === "m1")!;
  db.insert(
    "message",
    // trafegou por outra conexão → mapa de canais precisa do banco
    {
      ...base,
      id: "x1",
      externalId: "wamid.x1",
      content: "Pelo outro número",
      channelId: "ch_2",
      createdAt: minutesFromNoon(-50),
    },
    // cita mensagem que não está nesta página
    {
      ...base,
      id: "x2",
      externalId: "wamid.x2",
      content: "Sobre aquilo",
      replyToId: "o1",
      createdAt: minutesFromNoon(-49),
    },
    // template legado `[Template: nome]`
    {
      ...base,
      id: "x3",
      externalId: "wamid.x3",
      content: "[Template: boas_vindas]",
      direction: "out",
      senderName: USERS.member.name,
      createdAt: minutesFromNoon(-48),
    },
    // evento com ator genérico → procura o ator no log de atividade
    {
      ...base,
      id: "x4",
      externalId: null,
      content: "Conversa transferida",
      direction: "system",
      messageType: "event:transferencia",
      authorType: "system",
      senderName: "Agente",
      channelId: null,
      createdAt: minutesFromNoon(-47),
    },
    // resposta de WhatsApp Flow → rótulos dos campos
    {
      ...base,
      id: "x5",
      externalId: "wamid.x5",
      content: "*Resposta do formulário*\n*cpf*: 123",
      createdAt: minutesFromNoon(-46),
    },
  );
  db.insert("whatsAppTemplateConfig", {
    organizationId: ORG,
    metaTemplateName: "boas_vindas",
    bodyPreview: "Olá! Seja bem-vindo.",
    category: "MARKETING",
  });
  db.insert("activityEvent", {
    organizationId: ORG,
    conversationId: CONV.mine,
    type: "ASSIGNEE_CHANGED",
    actorType: "HUMAN",
    actorUserId: USERS.manager.id,
    actorLabel: USERS.manager.name,
    occurredAt: minutesFromNoon(-47),
  });
  db.insert("whatsappFlowDefinition", { id: "flow_1", organizationId: ORG, status: "PUBLISHED" });
  db.insert("whatsappFlowScreen", { id: "screen_1", flowId: "flow_1" });
  db.insert("whatsappFlowField", { screenId: "screen_1", fieldKey: "cpf", label: "CPF" });
}

/** Outro ticket ATIVO do mesmo contato+canal (entra na timeline) e dois que não entram. */
function addSiblings(db: FakeDb) {
  const mine = db.table("conversation").find((c) => c.id === CONV.mine)!;
  const base = db.table("message").find((m) => m.id === "m1")!;
  db.insert(
    "conversation",
    { ...mine, id: "conv_sibling", number: 201, status: "PENDING", assignedToId: USERS.other.id },
    {
      ...mine,
      id: "conv_sibling_ig",
      number: 202,
      channel: "instagram",
      channelId: null,
      assignedToId: USERS.other.id,
    },
  );
  db.insert(
    "message",
    {
      ...base,
      id: "s1",
      externalId: "wamid.s1",
      conversationId: "conv_sibling",
      content: "Do ticket irmão",
      createdAt: minutesFromNoon(-90),
    },
    {
      ...base,
      id: "s2",
      externalId: "wamid.s2",
      conversationId: "conv_sibling_ig",
      content: "Do Instagram (não entra)",
      createdAt: minutesFromNoon(-89),
    },
    {
      ...base,
      id: "r1",
      externalId: "wamid.r1",
      conversationId: CONV.resolved,
      content: "Do ticket encerrado",
      createdAt: minutesFromNoon(-5500),
    },
  );
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
  describe("dentro da meta: até 8 consultas em até 3 fases", () => {
    const dentroDaMeta = (c: Counts) => {
      expect(c.consultas).toBeLessThanOrEqual(8);
      expect(c.fases).toBeLessThanOrEqual(3);
    };

    it("operador abre a própria conversa (flag de escopo desligada)", async () => {
      setup("member");
      const warm = await openWarm(CONV.mine);
      expect(warm.status).toBe(200);
      expect((warm.body.messages as unknown[]).length).toBe(6);
      expect(warm.body.canReply).toBe(true);
      expect(warm.body.hasOlderTickets).toBe(true);
      expect(warm.body.pinnedMessageIds).toEqual(["wamid.m2"]);

      const c = measure("messages / operador, conversa própria, flag off", warm.entries);
      dentroDaMeta(c);
      expect(c).toEqual({ consultas: 8, fases: 3, redis: 2, redisEmSerie: 1 });
    });

    it("operador abre a própria conversa pelo número (bookmark ?c=101)", async () => {
      setup("member");
      const warm = await openWarm("101");
      expect(warm.status).toBe(200);
      expect((warm.body.messages as unknown[]).length).toBe(6);

      const c = measure(
        "messages / operador, conversa própria pelo número, flag off",
        warm.entries,
      );
      dentroDaMeta(c);
      expect(c).toEqual({ consultas: 8, fases: 3, redis: 2, redisEmSerie: 1 });
    });

    it("operador abre a própria conversa (flag ligada, regra de canal por usuário)", async () => {
      setup("member", { rbacFlag: true, scopeGrants: CHANNEL_BY_USER });
      const warm = await openWarm(CONV.mine);
      expect(warm.status).toBe(200);
      expect(warm.body.canReply).toBe(true);

      const c = measure(
        "messages / operador, conversa própria, flag on (canal por usuário)",
        warm.entries,
      );
      dentroDaMeta(c);
      expect(c).toEqual({ consultas: 8, fases: 3, redis: 3, redisEmSerie: 2 });
    });

    it("gestor abre conversa de outro agente (flag desligada)", async () => {
      setup("manager");
      const warm = await openWarm(CONV.others);
      expect(warm.status).toBe(200);

      const c = measure("messages / gestor, conversa de outro agente, flag off", warm.entries);
      dentroDaMeta(c);
      expect(c).toEqual({ consultas: 8, fases: 3, redis: 4, redisEmSerie: 2 });
    });

    it("admin abre conversa de outro agente (flag ligada)", async () => {
      setup("admin", { rbacFlag: true, scopeGrants: CHANNEL_BY_ROLE });
      const warm = await openWarm(CONV.others);
      expect(warm.status).toBe(200);

      const c = measure("messages / admin, conversa de outro agente, flag on", warm.entries);
      dentroDaMeta(c);
      expect(c).toEqual({ consultas: 7, fases: 3, redis: 5, redisEmSerie: 3 });
    });

    it("operador rola para a página anterior (?before)", async () => {
      setup("member");
      const warm = await openWarm(CONV.mine, "?before=2026-09-30T11:03:30.000Z");
      expect(warm.status).toBe(200);
      expect((warm.body.messages as unknown[]).length).toBe(4);

      const c = measure("messages / operador, página anterior (?before)", warm.entries);
      dentroDaMeta(c);
      expect(c).toEqual({ consultas: 7, fases: 3, redis: 2, redisEmSerie: 1 });
    });
  });

  describe("fora da meta (e por quê)", () => {
    it("regra de canal POR PAPEL: +1 consulta (os papéis do usuário), ainda em 3 fases", async () => {
      setup("member", { rbacFlag: true, scopeGrants: CHANNEL_BY_ROLE });
      const warm = await openWarm(CONV.mine);
      expect(warm.status).toBe(200);
      expect(warm.body.canReply).toBe(true);

      const c = measure(
        "messages / operador, conversa própria, flag on (canal por papel)",
        warm.entries,
      );
      expect(c).toEqual({ consultas: 9, fases: 3, redis: 3, redisEmSerie: 2 });

      await probe.run(clearCaches);
      setup("manager", { rbacFlag: true, scopeGrants: CHANNEL_BY_ROLE });
      const gestor = await openWarm(CONV.others);
      expect(gestor.status).toBe(200);
      expect(
        measure(
          "messages / gestor, conversa de outro agente, flag on (canal por papel)",
          gestor.entries,
        ),
      ).toEqual({ consultas: 9, fases: 3, redis: 5, redisEmSerie: 3 });
    });

    it("veredito que depende do banco (operador abre conversa da fila): +1 consulta e +1 fase", async () => {
      // Não é o responsável e a visibilidade dele é restrita: a regra
      // (dono do negócio OU fila/visibilidade E canal) vira um `count` na
      // linha — e as mensagens só são lidas DEPOIS do veredito.
      setup("member", {
        memberPermissions: QUEUE_PERMS,
        settings: { "unassigned.MEMBER": "true" },
      });
      const warm = await openWarm(CONV.queue);
      expect(warm.status).toBe(200);
      expect(measure("messages / operador, conversa da fila, flag off", warm.entries)).toEqual({
        consultas: 9,
        fases: 4,
        redis: 4,
        redisEmSerie: 2,
      });

      await probe.run(clearCaches);
      setup("member", {
        rbacFlag: true,
        scopeGrants: CHANNEL_BY_ROLE,
        memberPermissions: QUEUE_PERMS,
        settings: { "unassigned.MEMBER": "true" },
      });
      const comPapel = await openWarm(CONV.queue);
      expect(comPapel.status).toBe(200);
      expect(
        measure(
          "messages / operador, conversa da fila, flag on (canal por papel)",
          comPapel.entries,
        ),
      ).toEqual({ consultas: 10, fases: 4, redis: 5, redisEmSerie: 3 });
    });

    it("histórico (?history=1): os tickets antigos são lidos um a um — 4 fases", async () => {
      setup("member", { mutate: addSiblings });
      const warm = await openWarm(CONV.mine, "?history=1");
      expect(warm.status).toBe(200);
      const c = measure("messages / operador, histórico (?history=1)", warm.entries);
      expect(c).toEqual({ consultas: 7, fases: 4, redis: 2, redisEmSerie: 1 });
    });

    it("extras da página (outro canal, citação fora da página, template legado, evento genérico, flow): +1 cada, na fase 3", async () => {
      setup("member", { mutate: addExtras });
      const warm = await openWarm(CONV.mine);
      expect(warm.status).toBe(200);
      const c = measure("messages / operador, conversa com extras", warm.entries);
      expect(c).toEqual({ consultas: 13, fases: 3, redis: 2, redisEmSerie: 1 });
    });
  });
});

describe("GET /api/conversations — pré-checks antes da listagem", () => {
  const semRedisEmSerie = (c: Counts) => expect(c.redisEmSerie).toBe(1);

  it("operador, flag ligada", async () => {
    setup("member", {
      rbacFlag: true,
      scopeGrants: CHANNEL_BY_ROLE,
      memberPermissions: QUEUE_PERMS,
    });
    await listInbox("?tab=entrada");
    h.getConversations.mockClear();
    const warm = await listInbox("?tab=entrada");
    expect(warm.status).toBe(200);
    expect(h.getConversations).toHaveBeenCalledTimes(1);
    expect(h.getConversations.mock.calls[0]![0]).toMatchObject({ allowedChannelIds: ["ch_1"] });

    const c = measure("inbox / operador, flag on", warm.entries);
    semRedisEmSerie(c);
    expect(c).toEqual({ consultas: 2, fases: 1, redis: 5, redisEmSerie: 1 });
  });

  it("gestor em modo own (visibility.MANAGER=own), flag ligada", async () => {
    setup("manager", {
      rbacFlag: true,
      scopeGrants: CHANNEL_BY_ROLE,
      settings: { "visibility.MANAGER": "own" },
    });
    await listInbox("?tab=esperando");
    const warm = await listInbox("?tab=esperando");
    expect(warm.status).toBe(200);

    const c = measure("inbox / gestor own, flag on", warm.entries);
    semRedisEmSerie(c);
    expect(c).toEqual({ consultas: 2, fases: 1, redis: 5, redisEmSerie: 1 });
  });

  it("contadores (?counts=1), operador, flag ligada", async () => {
    setup("member", {
      rbacFlag: true,
      scopeGrants: CHANNEL_BY_ROLE,
      memberPermissions: QUEUE_PERMS,
    });
    await listInbox("?counts=1");
    h.getTabCounts.mockClear();
    const warm = await listInbox("?counts=1");
    expect(warm.status).toBe(200);
    expect(h.getTabCounts).toHaveBeenCalledTimes(1);

    const c = measure("inbox counts / operador, flag on", warm.entries);
    semRedisEmSerie(c);
    expect(c).toEqual({ consultas: 2, fases: 1, redis: 5, redisEmSerie: 1 });
  });

  it("os filtros que a listagem recebe não mudam com o memo", async () => {
    setup("member", {
      rbacFlag: true,
      scopeGrants: CHANNEL_BY_ROLE,
      memberPermissions: QUEUE_PERMS,
      settings: { "unassigned.MEMBER": "true" },
    });
    h.getConversations.mockClear();
    expect((await listInbox("?tab=entrada")).status).toBe(200);
    expect(h.getConversations.mock.calls[0]![0]).toMatchSnapshot("operador, fila de entrada");

    await probe.run(clearCaches);
    setup("manager", { departments: { manager: ["dep_1"] } });
    h.getConversations.mockClear();
    expect((await listInbox("?tab=esperando")).status).toBe(200);
    expect(h.getConversations.mock.calls[0]![0]).toMatchSnapshot("gestor restrito a departamento");

    await probe.run(clearCaches);
    setup("member");
    expect((await listInbox("?tab=entrada")).status).toBe(403);
  });
});

describe("GET /api/conversations/:id/messages — contrato da resposta", () => {
  it("primeira página: mensagens, fixados, favoritos, avatar, canal, sessão", async () => {
    setup("member");
    const res = await openConversation(CONV.mine);
    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it("pelo número da conversa devolve o mesmo corpo", async () => {
    setup("member");
    const porId = await openConversation(CONV.mine);
    const porNumero = await openConversation("101");
    expect(porNumero.status).toBe(200);
    expect(porNumero.body).toEqual(porId.body);
  });

  it("timeline unificada com o ticket ativo do mesmo contato+canal", async () => {
    setup("member", { mutate: addSiblings });
    const res = await openConversation(CONV.mine);
    expect(res.status).toBe(200);
    const contents = (res.body.messages as { content: string }[]).map((m) => m.content);
    expect(contents).toContain("Do ticket irmão");
    expect(contents).not.toContain("Do Instagram (não entra)");
    expect(contents).not.toContain("Do ticket encerrado");
    expect(res.body).toMatchSnapshot();
  });

  it("página anterior (?before) e página nova (?after)", async () => {
    setup("member");
    const before = await openConversation(
      CONV.mine,
      "?before=2026-09-30T11:03:30.000Z&limit=2",
    );
    expect(before.status).toBe(200);
    expect(before.body).toMatchSnapshot("before");
    const after = await openConversation(CONV.mine, "?after=2026-09-30T11:03:30.000Z");
    expect(after.status).toBe(200);
    expect(after.body).toMatchSnapshot("after");
  });

  it("histórico (?history=1) com separadores de ticket", async () => {
    setup("member", { mutate: addSiblings });
    const res = await openConversation(CONV.mine, "?history=1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it("extras: outro canal, citação fora da página, template legado, evento, flow", async () => {
    setup("member", { mutate: addExtras });
    const res = await openConversation(CONV.mine);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.channels as object).sort()).toEqual(["ch_1", "ch_2"]);
    expect(res.body).toMatchSnapshot();
  });

  it("canReply segue a regra de envio do canal (flag ligada)", async () => {
    setup("member", {
      rbacFlag: true,
      scopeGrants: { channel: { send: { users: { [USERS.member.id]: ["ch_2"] } } } },
    });
    const negado = await openConversation(CONV.mine);
    expect(negado.status).toBe(200);
    expect(negado.body.canReply).toBe(false);

    await probe.run(clearCaches);
    setup("member", {
      rbacFlag: true,
      scopeGrants: { channel: { send: { roles: { role_member: ["ch_1"] } } } },
    });
    const liberado = await openConversation(CONV.mine);
    expect(liberado.body.canReply).toBe(true);

    await probe.run(clearCaches);
    setup("member", {
      rbacFlag: true,
      scopeGrants: { channel: { send: { roles: { role_member: ["ch_2"] } } } },
    });
    const negadoPorPapel = await openConversation(CONV.mine);
    expect(negadoPorPapel.body.canReply).toBe(false);

    await probe.run(clearCaches);
    setup("member", {
      rbacFlag: false,
      scopeGrants: { channel: { send: { users: { [USERS.member.id]: ["ch_2"] } } } },
    });
    const flagOff = await openConversation(CONV.mine);
    expect(flagOff.body.canReply).toBe(true);
  });
});

describe("GET /api/conversations/:id/messages — autorização negativa", () => {
  /** Nada da conversa (mensagens, fixados, favoritos, sessão) pode ser lido sem veredito. */
  const DATA_MODELS = /^(message|pinnedMessage|favoriteMessage|user|channel|activityEvent)\./;
  const NOT_FOUND = { message: "Conversa não encontrada ou sem permissão." };

  async function expectDenied(id: string, query = "") {
    const res = await openConversation(id, query);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    const leu = probe
      .stats("pg", res.entries)
      .byPhase.flat()
      .filter((label) => DATA_MODELS.test(label));
    expect(leu).toEqual([]);
    return res;
  }

  it("operador não abre conversa de outro agente, da fila sem permissão, nem inexistente", async () => {
    setup("member");
    await expectDenied(CONV.others);
    await expectDenied(CONV.queue);
    await expectDenied("conv_nao_existe");
    await expectDenied("999999");
    await expectDenied("0");
    // 102 = conversa de outro agente, pelo número
    await expectDenied("102");
    await expectDenied(CONV.others, "?history=1");
  });

  it("conversa de outra organização: 404, mesmo sendo o mesmo número", async () => {
    setup("admin");
    await expectDenied(CONV.foreign);
    // nº 101 existe nas duas orgs; o admin da org_1 recebe a da org_1.
    const mine = await openConversation("101");
    expect(mine.status).toBe(200);
    expect((mine.body.channel as { id: string }).id).toBe("ch_1");
  });

  it("canal fora do escopo do usuário (flag ligada)", async () => {
    setup("manager", {
      rbacFlag: true,
      scopeGrants: { channel: { view: { roles: { role_manager: ["ch_2"] } } } },
    });
    await expectDenied(CONV.others);
    await expectDenied(CONV.queue);
  });

  it("departamento fora do escopo do gestor", async () => {
    setup("manager", { departments: { manager: ["dep_1"] } });
    await expectDenied(CONV.others);
  });

  it("funil bloqueado: nem o responsável nem o dono do negócio abrem", async () => {
    setup("member", {
      mutate: (db) => {
        db.insert("roleStageGrant", {
          roleId: "role_member",
          stageId: "st_1",
          canView: false,
          canEdit: false,
        });
        db.insert("rolePipelineGrant", {
          roleId: "role_member",
          pipelineId: "p_2",
          canView: false,
        });
      },
    });
    await expectDenied(CONV.mine);
    await expectDenied(CONV.dealOwner);
  });

  it("dono do negócio abre a conversa atribuída a outro agente", async () => {
    setup("member");
    const res = await openConversation(CONV.dealOwner);
    expect(res.status).toBe(200);
    expect((res.body.messages as unknown[]).length).toBe(6);
  });

  it("401 sem sessão", async () => {
    setup("member");
    h.session = null;
    const res = await openConversation(CONV.mine);
    expect(res.status).toBe(401);
    expect(res.entries.filter((e) => e.kind === "pg")).toEqual([]);
  });

  it("o memo é da requisição: trocar de usuário não reaproveita o veredito", async () => {
    setup("member", { settings: { "visibility.MANAGER": "own" } });
    expect((await openConversation(CONV.mine)).status).toBe(200);
    // gestor em modo own não vê a conversa do operador
    h.session = sessionFor("manager");
    await expectDenied(CONV.mine);
    h.session = sessionFor("member");
    expect((await openConversation(CONV.mine)).status).toBe(200);
  });
});
