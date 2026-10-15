/**
 * `GET /api/conversations/:id/messages` — ETag, 304 e delta (gate de carga
 * de 15/10, metas 6 e 7).
 *
 *   - página inteira com `ETag` + `cursor`; `If-None-Match` igual → 304 sem
 *     ler mensagem nenhuma (só a leitura da conversa que decide o acesso);
 *   - escrita (bump) → o mesmo `If-None-Match` volta 200;
 *   - `?after=<cursor>` devolve só o que mudou: nova, status, edição,
 *     exclusão; sem mudança → vazio e, revalidando, 304;
 *   - usuário de outra org recebe 404, nunca 304, mesmo com ETag válido.
 *
 * Mesmo arranjo de `empty-ticket-history.test.ts` (Prisma espião sobre o
 * banco em memória) + os scripts Lua das versões emulados no Redis falso.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.FEATURE_FLAG_RBAC_GRANULAR_SCOPE_V1;
  return {
    session: null as unknown,
    emu: null as null | import("@/test-setup/fake-msgs-redis").FakeMsgsScripts,
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
  const { fakeMsgsScripts } = await import("@/test-setup/fake-msgs-redis");
  h.emu = fakeMsgsScripts({
    get: (k) => probe.redisStore.get(k) ?? null,
    set: (k, v) => {
      probe.redisStore.set(k, v);
    },
  });
  type EvalResult = ReturnType<InstanceType<typeof probe.FakeRedis>["eval"]>;
  class FakeWithMsgs extends probe.FakeRedis {
    eval(script: string, n: number, ...rest: string[]): EvalResult {
      if (/--\s*crm:msgs-/.test(script)) {
        return Promise.resolve(h.emu!.eval(script, n, rest)) as unknown as EvalResult;
      }
      return super.eval(script, n, rest[0]!, rest[1]!);
    }
  }
  return { default: FakeWithMsgs };
});
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));
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

import { GET as getMessages } from "@/app/api/conversations/[id]/messages/route";
import { cache } from "@/lib/cache";
import { noteMessageChange } from "@/lib/cache/message-versions";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import type { FakeDb } from "@/test-setup/fake-db";
import { CONV, ORG, OTHER_ORG, seedInbox, sessionFor } from "@/test-setup/inbox-fixture";
import { probe } from "@/test-setup/io-probe";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");

type Body = {
  messages?: { id: string; content: string; status?: string }[];
  cursor?: string;
  delta?: boolean;
  reset?: boolean;
  items?: { id: string; content: string }[];
  changed?: { id: string; content: string; status?: string }[];
  deleted?: string[];
};

async function get(id: string, query = "", headers: Record<string, string> = {}) {
  const run = await probe.run(() =>
    getMessages(
      new Request(`http://localhost/api/conversations/${id}/messages${query}`, { headers }),
      { params: Promise.resolve({ id }) },
    ),
  );
  const res = run.result as Response;
  const text = res.status === 304 ? "" : await res.text();
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    cacheControl: res.headers.get("cache-control"),
    vary: res.headers.get("vary"),
    body: (text ? JSON.parse(text) : {}) as Body,
    /** Leituras do Postgres desta requisição (`modelo.operação`). */
    pg: run.entries.filter((e) => e.kind === "pg").map((e) => e.label),
  };
}

let db: FakeDb;

function seed() {
  db = seedInbox();
  probe.setDbHandler((model, operation, args) => db.run(model, operation, args));
  h.session = sessionFor("member");
}

function msg(id: string) {
  return db.table("message").find((m) => m.id === id)!;
}

/** Mensagem nova gravada + bump, como faz o escritor real. */
async function addMessage(id: string, content: string, minutes: number) {
  db.insert("message", {
    ...msg("m6"),
    id,
    externalId: `wamid.${id}`,
    content,
    createdAt: new Date(T0 + minutes * 60_000),
  });
  await probe.run(() => noteMessageChange(ORG, CONV.mine, "new", id, `wamid.${id}`));
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(T0));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  probe.reset();
  h.emu?.reset();
  await probe.run(() => cache.delPattern("*"));
  probe.reset();
  resetCacheVersionsForTests();
  seed();
});

describe("GET /messages — ETag e 304", () => {
  it("página com ETag/cursor; If-None-Match igual → 304 sem ler mensagens", async () => {
    const first = await get(CONV.mine, "?limit=40");
    expect(first.status).toBe(200);
    expect(first.etag).toMatch(/^W\/"f\.[0-9a-f]{24}\.[0-9a-z]+"$/);
    expect(first.cacheControl).toBe("private, no-cache");
    expect(first.vary).toContain("Cookie");
    expect(first.body.cursor).toMatch(/^m1\./);
    expect(first.pg).toContain("message.findMany");

    const again = await get(CONV.mine, "?limit=40", { "if-none-match": first.etag! });
    expect(again.status).toBe(304);
    expect(again.etag).toBe(first.etag);
    // Só a leitura da conversa que decide o acesso (e o que ela já fazia
    // em paralelo). Nenhuma leitura de mensagem, fixada, favorito, usuário,
    // canal, sessão ou ticket anterior.
    expect(again.pg.filter((l) => !l.startsWith("conversation.") && !l.startsWith("agentPermission.") && !l.startsWith("userRoleAssignment.") && !l.startsWith("role.") && !l.startsWith("organizationSetting."))).toEqual([]);
    expect(again.pg).not.toContain("message.findMany");
    expect(again.pg).not.toContain("message.findFirst");
    expect(again.pg.filter((l) => l.startsWith("conversation.")).length).toBeLessThanOrEqual(1);
  });

  it("nova mensagem (bump) → o mesmo If-None-Match volta 200 com a mensagem", async () => {
    const first = await get(CONV.mine, "?limit=40");
    await addMessage("m7", "Mais uma dúvida", -1);
    const again = await get(CONV.mine, "?limit=40", { "if-none-match": first.etag! });
    expect(again.status).toBe(200);
    expect(again.etag).not.toBe(first.etag);
    expect(again.body.messages!.map((m) => m.content)).toContain("Mais uma dúvida");
  });

  it("parâmetros diferentes (limit) não casam o ETag de outra consulta", async () => {
    const first = await get(CONV.mine, "?limit=40");
    const other = await get(CONV.mine, "?limit=20", { "if-none-match": first.etag! });
    expect(other.status).toBe(200);
  });

  it("janela de 24 h vence sem escrita → não responde 304 com a sessão velha", async () => {
    const first = await get(CONV.mine, "?limit=40");
    vi.setSystemTime(new Date(T0 + 25 * 60 * 60_000));
    try {
      const later = await get(CONV.mine, "?limit=40", { "if-none-match": first.etag! });
      expect(later.status).toBe(200);
    } finally {
      vi.setSystemTime(new Date(T0));
    }
  });

  it("usuário de outra org: 404, nunca 304 — mesmo com o ETag certo", async () => {
    const first = await get(CONV.mine, "?limit=40");
    h.session = sessionFor("member", { organizationId: OTHER_ORG });
    const foreign = await get(CONV.mine, "?limit=40", { "if-none-match": first.etag! });
    expect(foreign.status).toBe(404);
    const foreignDelta = await get(CONV.mine, `?after=${first.body.cursor}`, {
      "if-none-match": `W/"${first.body.cursor}"`,
    });
    expect(foreignDelta.status).toBe(404);
  });

  it("outro usuário da mesma org não reaproveita o ETag (favorito/canReply são por usuário)", async () => {
    const first = await get(CONV.mine, "?limit=40");
    h.session = sessionFor("admin");
    const admin = await get(CONV.mine, "?limit=40", { "if-none-match": first.etag! });
    expect(admin.status).toBe(200);
  });
});

describe("GET /messages?after=<cursor> — delta", () => {
  it("sem mudança: vazio com ETag = cursor; revalidando, 304 sem banco", async () => {
    const page = await get(CONV.mine, "?limit=40");
    const cursor = page.body.cursor!;
    const d1 = await get(CONV.mine, `?after=${cursor}`);
    expect(d1.status).toBe(200);
    expect(d1.body).toMatchObject({ delta: true, reset: false, items: [], changed: [], deleted: [] });
    expect(d1.etag).toBe(`W/"${cursor}"`);
    expect(d1.pg).not.toContain("message.findMany");

    const d2 = await get(CONV.mine, `?after=${cursor}`, { "if-none-match": d1.etag! });
    expect(d2.status).toBe(304);
    expect(d2.pg).not.toContain("message.findMany");
  });

  it("devolve só o que mudou: nova, status, edição e exclusão", async () => {
    const page = await get(CONV.mine, "?limit=40");
    const cursor = page.body.cursor!;

    await addMessage("m7", "Chegou agora", -1);
    msg("m4").sendStatus = "read";
    await probe.run(() => noteMessageChange(ORG, CONV.mine, "upd", "m4", "wamid.m4"));
    msg("m2").content = "Claro! Qual curso? (editada)";
    await probe.run(() => noteMessageChange(ORG, CONV.mine, "upd", "m2"));
    const t = db.table("message");
    t.splice(t.findIndex((m) => m.id === "m3"), 1);
    await probe.run(() => noteMessageChange(ORG, CONV.mine, "del", "m3", "wamid.m3"));

    const d = await get(CONV.mine, `?after=${cursor}`);
    expect(d.status).toBe(200);
    expect(d.body.delta).toBe(true);
    expect(d.body.reset).toBe(false);
    expect(d.body.items!.map((m) => [m.id, m.content])).toEqual([["wamid.m7", "Chegou agora"]]);
    expect(d.body.changed!.map((m) => m.id).sort()).toEqual(["wamid.m2", "wamid.m4"]);
    expect(d.body.changed!.find((m) => m.id === "wamid.m4")!.status).toBe("READ");
    expect(d.body.changed!.find((m) => m.id === "wamid.m2")!.content).toBe(
      "Claro! Qual curso? (editada)",
    );
    expect(d.body.deleted).toEqual(["m3", "wamid.m3"]);
    // Delta cumulativo: o cliente revalida a MESMA URL; nada mudou → 304.
    const again = await get(CONV.mine, `?after=${cursor}`, { "if-none-match": d.etag! });
    expect(again.status).toBe(304);
    expect(again.pg).not.toContain("message.findMany");
  });

  it("mensagem anunciada e ainda não visível segura o cursor (não se perde)", async () => {
    const page = await get(CONV.mine, "?limit=40");
    const cursor = page.body.cursor!;
    // Bump chegou antes de a linha aparecer (escrita em voo).
    await probe.run(() => noteMessageChange(ORG, CONV.mine, "new", "m8"));
    const d1 = await get(CONV.mine, `?after=${cursor}`);
    expect(d1.body.items).toEqual([]);
    expect(d1.body.deleted).toEqual([]);
    // A linha aparece: o próximo delta (mesmo ETag) não é 304 e a traz.
    db.insert("message", { ...msg("m6"), id: "m8", externalId: null, content: "Atrasada" });
    const d2 = await get(CONV.mine, `?after=${cursor}`, { "if-none-match": d1.etag! });
    expect(d2.status).toBe(200);
    expect(d2.body.items!.map((m) => m.content)).toEqual(["Atrasada"]);
  });

  it("cursor inválido ou de outra linha do tempo → página inteira com reset", async () => {
    const page = await get(CONV.mine, "?limit=40");
    const bad = await get(CONV.mine, "?after=m1.lixo");
    expect(bad.status).toBe(200);
    expect(bad.body.reset).toBe(true);
    expect(bad.body.messages!.length).toBeGreaterThan(0);

    // Cursor de outro usuário (mesma org): não vale.
    h.session = sessionFor("admin");
    const other = await get(CONV.mine, `?after=${page.body.cursor}`);
    expect(other.body.reset).toBe(true);
  });

  it("isolamento: bump em outra org (mesmo id de conversa) não muda nada aqui", async () => {
    const page = await get(CONV.mine, "?limit=40");
    await probe.run(() => noteMessageChange(OTHER_ORG, CONV.mine, "new", "x1"));
    const again = await get(CONV.mine, "?limit=40", { "if-none-match": page.etag! });
    expect(again.status).toBe(304);
  });
});
