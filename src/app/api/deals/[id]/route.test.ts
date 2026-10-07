/**
 * GET /api/deals/:id (B5) — painel do negócio.
 *
 * Banco em memória sem latência; cada consulta registra a profundidade em
 * série (1 + a maior profundidade já concluída quando ela começou, como em
 * `io-probe.ts`). Mede quantas idas ao Postgres a rota encadeia e confere
 * que as checagens continuam: etapa/funil negados e visibilidade negada
 * devolvem 403 sem os campos do painel.
 */
import { writeFileSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pg: [] as Array<{ label: string; depth: number }>,
  doneDepth: 0,
  stageDenied: false,
  canSeeAll: true,
  lastMessageAt: true as boolean,
  results: [] as Array<{ scenario: string; pgCalls: number; pgDepth: number; labels: string[] }>,
}));

async function pg<T>(label: string, value: T): Promise<T> {
  const depth = h.doneDepth + 1;
  h.pg.push({ label, depth });
  await new Promise((r) => setImmediate(r));
  h.doneDepth = Math.max(h.doneDepth, depth);
  return value;
}

/** Redis/authz: assíncrono, sem contar como ida ao Postgres. */
async function redis<T>(value: T): Promise<T> {
  await new Promise((r) => setImmediate(r));
  return value;
}

const T = (d: string) => new Date(`2026-${d}T12:00:00.000Z`);

function dealRow() {
  return {
    id: "deal_1",
    number: 1389,
    ownerId: "user_b",
    title: "Negócio",
    tags: [{ tag: { id: "t1", name: "VIP", color: "#f00" } }],
    stage: {
      id: "st_1",
      name: "Etapa",
      pipeline: { id: "pipe_1", name: "Funil", stages: [{ id: "st_1" }, { id: "st_2" }] },
    },
    contact: {
      id: "ct_1",
      name: "Cliente",
      // Com foto: o fallback de avatar (lê usuários) não roda e não mascara
      // a fase do groupBy.
      avatarUrl: "https://exemplo.com/foto.jpg",
      tags: [],
      conversations: [
        {
          id: "conv_vazio",
          status: "RESOLVED",
          // Sem chat: coluna vazia (ou fora do backfill quando `lastMessageAt` = false).
          lastMessageAt: h.lastMessageAt ? T("09-01") : null,
          updatedAt: T("10-04"),
        },
        {
          id: "conv_chat",
          status: "RESOLVED",
          lastMessageAt: h.lastMessageAt ? T("10-01") : null,
          updatedAt: T("10-02"),
        },
      ],
    },
  };
}

vi.mock("@/lib/prisma", () => ({
  allocateOrgNumber: vi.fn(),
  prisma: {
    deal: { findUnique: vi.fn(() => pg("deal.findUnique", dealRow())) },
    message: {
      groupBy: vi.fn((args: { where: { conversationId: { in: string[] } } }) =>
        pg(
          "message.groupBy",
          args.where.conversationId.in.includes("conv_chat")
            ? [{ conversationId: "conv_chat", _max: { createdAt: T("10-01") } }]
            : [],
        ),
      ),
    },
    user: { findMany: vi.fn(() => pg("user.findMany(avatar)", [])) },
    customField: {
      findMany: vi.fn(() =>
        pg("customField.findMany", [
          {
            id: "cf_1",
            name: "polo",
            label: "Polo",
            type: "TEXT",
            options: null,
            highlightRules: [],
            inboxLeadPanelOrder: 1,
          },
        ]),
      ),
    },
    dealCustomFieldValue: {
      findMany: vi.fn(() =>
        pg("dealCustomFieldValue.findMany", [
          { customFieldId: "cf_1", value: "Centro" },
          { customFieldId: "cf_fora_do_painel", value: "x" },
        ]),
      ),
    },
  },
}));
vi.mock("@/lib/api-auth", async () => {
  const { runWithContext } = await import("@/lib/request-context");
  return {
    authenticateApiRequest: vi.fn(async () => ({
      ok: true,
      user: { id: "user_a", role: "MEMBER", organizationId: "org_1", isSuperAdmin: false },
    })),
    runWithApiUserContext: (user: { id: string; organizationId: string }, fn: () => unknown) =>
      runWithContext(
        { organizationId: user.organizationId, userId: user.id, isSuperAdmin: false } as never,
        fn,
      ),
  };
});
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  loadAuthzContext: vi.fn(() =>
    redis({ isAdmin: false, isSuperAdmin: false, stageDeny: new Set(["st_2"]), stageView: null }),
  ),
}));
vi.mock("@/lib/authz/resource-policy", async () => {
  const { NextResponse } = await import("next/server");
  const deny = () => NextResponse.json({ message: "Acesso negado à etapa." }, { status: 403 });
  return {
    requirePermissionForUser: vi.fn(() => redis(null)),
    requireStageScope: vi.fn(() => redis(h.stageDenied ? deny() : null)),
    requirePipelineScope: vi.fn(() => redis(null)),
    canEditFieldForUser: vi.fn(),
  };
});
vi.mock("@/lib/visibility", async (importOriginal) => ({
  // `canSeeDealByOwner` é a regra pura de posse — fica a real.
  canSeeDealByOwner: (await importOriginal<typeof import("@/lib/visibility")>()).canSeeDealByOwner,
  // Não-ADMIN: lê `agentPermission` no Postgres.
  getVisibilityFilter: vi.fn(() =>
    pg("agentPermission.findFirst(visibilidade)", {
      canSeeAll: h.canSeeAll,
      includeUnassigned: false,
      dealWhere: {},
    }),
  ),
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: vi.fn() }));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn(),
  userIdForFk: vi.fn(),
  withAutomationOriginMeta: vi.fn((m: unknown) => m),
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

import { GET } from "@/app/api/deals/[id]/route";

async function call(scenario: string) {
  h.pg.length = 0;
  h.doneDepth = 0;
  const res = await GET(new Request("http://localhost/api/deals/1389"), {
    params: Promise.resolve({ id: "1389" }),
  });
  h.results.push({
    scenario,
    pgCalls: h.pg.length,
    pgDepth: h.doneDepth,
    labels: h.pg.map((p) => `${p.depth}:${p.label}`),
  });
  return res;
}

beforeEach(() => {
  h.stageDenied = false;
  h.canSeeAll = true;
  h.lastMessageAt = true;
});

afterAll(() => {
  const out = process.env.DEAL_BENCH_OUT;
  if (out) writeFileSync(out, JSON.stringify(h.results, null, 2));
});

describe("GET /api/deals/:id", () => {
  it("contrato: negócio, tags achatadas, etapas visíveis, campos do painel e o ticket com chat primeiro", async () => {
    const res = await call("lastMessageAt preenchido");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("deal_1");
    expect(body.tags).toEqual([{ id: "t1", name: "VIP", color: "#f00" }]);
    expect(body.stage.pipeline.stages.map((s: { id: string }) => s.id)).toEqual(["st_1"]);
    expect(body.dealPanelFields).toEqual([
      expect.objectContaining({ fieldId: "cf_1", label: "Polo", value: "Centro" }),
    ]);
    expect(body.contact.conversations.map((c: { id: string }) => c.id)).toEqual([
      "conv_chat",
      "conv_vazio",
    ]);
  });

  it("lastMessageAt preenchido: sem groupBy em messages; 2 idas em série", async () => {
    await call("lastMessageAt preenchido (fases)");
    const last = h.results.at(-1)!;
    expect(last.labels.some((l) => l.endsWith("message.groupBy"))).toBe(false);
    expect(last.pgDepth).toBe(2);
  });

  it("lastMessageAt vazio: groupBy só dos tickets sem a coluna (3 idas em série)", async () => {
    h.lastMessageAt = false;
    await call("lastMessageAt vazio");
    expect(h.pg.map((p) => p.label)).toContain("message.groupBy");
    expect(h.results.at(-1)!.pgDepth).toBe(3);
  });

  it("authz e visibilidade saem junto com o negócio; campos do painel junto com as checagens", async () => {
    await call("paralelismo");
    const depthOf = (label: string) => h.pg.find((p) => p.label === label)!.depth;
    expect(depthOf("agentPermission.findFirst(visibilidade)")).toBe(depthOf("deal.findUnique"));
    expect(depthOf("customField.findMany")).toBe(depthOf("dealCustomFieldValue.findMany"));
  });

  it("etapa negada: 403 sem campos do painel", async () => {
    h.stageDenied = true;
    const res = await call("etapa negada");
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("dealPanelFields");
  });

  it("visibilidade negada (não é dono): 403", async () => {
    h.canSeeAll = false;
    const res = await call("visibilidade negada");
    expect(res.status).toBe(403);
  });

  it("Server-Timing com as fases", async () => {
    const res = await call("server-timing");
    expect(res.headers.get("server-timing")).toMatch(/auth;dur=.*deal;dur=.*checks;dur=.*total;dur=/);
  });
});
