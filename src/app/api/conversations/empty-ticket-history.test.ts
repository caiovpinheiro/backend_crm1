/**
 * `GET /api/conversations/:id/messages` — ticket atual VAZIO com mensagens em
 * outros tickets do contato.
 *
 * Sintoma no DEV (negócios #463, #129, #116): o painel abre um ticket
 * encerrado sem mensagens e mostra "Nenhuma mensagem nesta conversa.",
 * enquanto a prévia do card vem de um ticket anterior. Do lado da API o que
 * precisa valer:
 *   - ticket vazio + ticket anterior encerrado do mesmo canal →
 *     `hasOlderTickets: true` e `?history=1` devolve as mensagens dele;
 *   - `hasOlderTickets` só promete o que `?history=1` entrega (tickets
 *     encerrados ANTERIORES, do mesmo canal) — sem falso positivo;
 *   - ticket atual com mensagens segue igual.
 *
 * Mesmo arranjo de `query-count.test.ts`: Prisma espião sobre o banco em
 * memória, com a extension de tenant ligada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.FEATURE_FLAG_RBAC_GRANULAR_SCOPE_V1;
  return { session: null as unknown };
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

import { GET as getMessages } from "@/app/api/conversations/[id]/messages/route";
import { cache } from "@/lib/cache";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import type { FakeDb } from "@/test-setup/fake-db";
import { CONV, seedInbox, sessionFor, USERS } from "@/test-setup/inbox-fixture";
import { probe } from "@/test-setup/io-probe";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** Ticket aberto pelo painel: encerrado, SEM mensagens (ex.: Nº 32344). */
const EMPTY = "conv_empty";

type Msg = { id: string; messageType?: string; content: string };

async function open(id: string, query = "") {
  const run = await probe.run(() =>
    getMessages(new Request(`http://localhost/api/conversations/${id}/messages${query}`), {
      params: Promise.resolve({ id }),
    }),
  );
  const res = run.result as Response;
  const body = (await res.json()) as {
    messages: Msg[];
    hasMore?: boolean;
    hasOlderTickets?: boolean;
  };
  return { status: res.status, body };
}

const chat = (messages: Msg[]) => messages.filter((m) => m.messageType !== "ticket-separator");
const contents = (messages: Msg[]) => chat(messages).map((m) => m.content);

/** Thread do fixture (`addThread`), na ordem cronológica. */
const THREAD = [
  "Olá, quero saber do curso",
  "Claro! Qual curso?",
  "Administração",
  "Segue a grade",
  "Conversa atribuída a Ana Lima",
  "Obrigado!",
];

/**
 * Contato `ct_1` sem ticket ativo: o ticket do fixture (`CONV.mine`) vira
 * encerrado e sem mensagens fica um ticket novo, vazio, encerrado depois.
 */
function seed(mutate: (db: FakeDb, tools: { addMessage: (conversationId: string, id: string, content: string, minutes: number) => void }) => void) {
  const db = seedInbox({
    mutate: (d) => {
      const mine = d.table("conversation").find((c) => c.id === CONV.mine)!;
      const base = d.table("message").find((m) => m.id === "m1")!;
      mine.status = "RESOLVED";
      mine.closedAt = at(-200);
      d.insert("conversation", {
        ...mine,
        id: EMPTY,
        number: 32344,
        status: "RESOLVED",
        createdAt: at(-100),
        closedAt: at(-90),
      });
      const addMessage = (conversationId: string, id: string, content: string, minutes: number) =>
        d.insert("message", {
          ...base,
          id,
          externalId: `wamid.${id}`,
          conversationId,
          content,
          createdAt: at(minutes),
        });
      mutate(d, { addMessage });
    },
  });
  probe.setDbHandler((model, operation, args) => db.run(model, operation, args));
  h.session = sessionFor("member");
  return db;
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
  await probe.run(() => cache.delPattern("*"));
  probe.reset();
  resetCacheVersionsForTests();
});

describe("GET /messages — ticket atual vazio", () => {
  it("mensagens em ticket anterior do mesmo canal: página vazia, hasOlderTickets e histórico alcançável", async () => {
    seed(() => undefined);

    const page = await open(EMPTY, "?limit=40");
    expect(page.status).toBe(200);
    expect(page.body.messages).toEqual([]);
    expect(page.body.hasMore).toBe(false);
    expect(page.body.hasOlderTickets).toBe(true);

    // A fatia que o chat pede sozinho quando o ticket atual está vazio.
    const history = await open(EMPTY, "?history=1&limit=25&budget=25");
    expect(history.status).toBe(200);
    const separator = history.body.messages.find((m) => m.messageType === "ticket-separator");
    expect(separator).toBeDefined();
    expect(contents(history.body.messages)).toEqual(THREAD);
  });

  it("pula tickets anteriores vazios até achar o que tem mensagens", async () => {
    seed((db) => {
      const empty = db.table("conversation").find((c) => c.id === EMPTY)!;
      db.insert("conversation", {
        ...empty,
        id: "conv_empty_older",
        number: 32341,
        createdAt: at(-150),
        closedAt: at(-140),
      });
    });

    const history = await open(EMPTY, "?history=1&limit=25&budget=25");
    expect(contents(history.body.messages)).toEqual(THREAD);
  });

  it("tickets em dois canais: o histórico não mistura canal e hasOlderTickets não promete o que não entrega", async () => {
    seed((db, { addMessage }) => {
      // As mensagens do contato estão todas num ticket do Instagram.
      const mine = db.table("conversation").find((c) => c.id === CONV.mine)!;
      mine.channel = "instagram";
      mine.channelId = null;
      const resolved = db.table("conversation").find((c) => c.id === CONV.resolved)!;
      resolved.channel = "instagram";
      resolved.channelId = null;
      addMessage(CONV.resolved, "ig_old", "Do Instagram, ticket antigo", -5500);
    });

    const page = await open(EMPTY, "?limit=40");
    expect(page.body.messages).toEqual([]);
    expect(page.body.hasOlderTickets).toBe(false);

    const history = await open(EMPTY, "?history=1&limit=25&budget=25");
    expect(history.body.messages).toEqual([]);

    // Pelo ticket do próprio canal as mensagens e o ticket anterior aparecem.
    const instagram = await open(CONV.mine, "?limit=40");
    expect(chat(instagram.body.messages).length).toBe(6);
    expect(instagram.body.hasOlderTickets).toBe(true);
    const igHistory = await open(CONV.mine, "?history=1&limit=25&budget=25");
    expect(contents(igHistory.body.messages)).toEqual(["Do Instagram, ticket antigo"]);
  });

  it("só existe ticket encerrado MAIS NOVO: hasOlderTickets é falso (o histórico só anda para trás)", async () => {
    seed((db) => {
      // O ticket vazio passa a ser o mais antigo do contato.
      const empty = db.table("conversation").find((c) => c.id === EMPTY)!;
      empty.createdAt = at(-9000);
      empty.closedAt = at(-8990);
    });

    const page = await open(EMPTY, "?limit=40");
    expect(page.body.messages).toEqual([]);
    const history = await open(EMPTY, "?history=1&limit=25&budget=25");
    expect(history.body.messages).toEqual([]);
    // Antes: `true` — o chat pedia um histórico que nunca vinha.
    expect(page.body.hasOlderTickets).toBe(false);
  });
});

describe("GET /messages — ticket atual com mensagens (não regride)", () => {
  it("devolve as mensagens do ticket e sinaliza o ticket anterior", async () => {
    seedInboxDefault();
    const page = await open(CONV.mine, "?limit=40");
    expect(page.status).toBe(200);
    expect(contents(page.body.messages)).toEqual(THREAD);
    expect(page.body.hasOlderTickets).toBe(true);
  });

  it("outro operador continua sem acesso ao ticket vazio de conversa alheia", async () => {
    seed((db) => {
      const empty = db.table("conversation").find((c) => c.id === EMPTY)!;
      empty.assignedToId = USERS.other.id;
      const mine = db.table("conversation").find((c) => c.id === CONV.mine)!;
      mine.assignedToId = USERS.other.id;
      const resolved = db.table("conversation").find((c) => c.id === CONV.resolved)!;
      resolved.assignedToId = USERS.other.id;
    });
    const page = await open(EMPTY, "?limit=40");
    expect(page.status).toBe(404);
    const history = await open(EMPTY, "?history=1&limit=25&budget=25");
    expect(history.status).toBe(404);
  });
});

function seedInboxDefault() {
  const db = seedInbox();
  probe.setDbHandler((model, operation, args) => db.run(model, operation, args));
  h.session = sessionFor("member");
}
