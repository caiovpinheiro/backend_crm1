/**
 * `Server-Timing` nas rotas do Dashboard: GET /api/painel/service, /api/painel/team,
 * /api/painel/deals e /api/analytics/tabulations.
 *
 * Só instrumentação: corpo e status não mudam. O cabeçalho traz `auth`, as fases
 * de consulta (`q-<seção>`), `cache` (hit/miss/stale, onde há cache), `serialize`
 * e `total`. Os serviços rodam de verdade; só o banco, a réplica e a sessão são
 * simulados. O cache é o real (fallback em memória, sem Redis).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  replicaActive: false,
  role: "ADMIN" as "ADMIN" | "MANAGER" | "MEMBER",
  queryRaw: vi.fn(async (): Promise<unknown[]> => []),
  dealCount: vi.fn(async () => 0),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) =>
    cb({ user: { id: "u1", role: h.role, organizationId: "org_1", isSuperAdmin: false } }),
  isManagerOrAdmin: (s: { user: { role: string } }) =>
    s.user.role === "ADMIN" || s.user.role === "MANAGER",
  isSuperAdmin: () => false,
}));
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    $queryRaw: h.queryRaw,
    deal: { count: h.dealCount },
    conversation: { count: async () => 0 },
    pipeline: { findUnique: async () => null },
    activityEvent: { count: async () => 0, findMany: async () => [] },
    tabulation: { findMany: async () => [] },
    user: { findMany: async () => [] },
    department: { findMany: async () => [] },
    aIAgentConfig: { findMany: async () => [] },
  }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/prisma-replica", () => ({
  isReplicaActive: () => h.replicaActive,
  isReplicaTripped: () => false,
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/services/painel-agora", () => ({ getPainelAgora: vi.fn() }));
vi.mock("@/services/painel-hours", () => ({ loadPainelHours: vi.fn() }));
vi.mock("@/services/painel-snapshots", () => ({ ensureTodayDealStageSnapshot: vi.fn() }));
vi.mock("@/services/dashboard", () => ({ SOURCE_NONE: "__none__" }));
vi.mock("@/services/kanban-filters", () => ({ buildDealWhereFromFilters: async () => [] }));
vi.mock("@/services/pipelines", () => ({
  getDefaultPipelineId: async () => "pipe_1",
  resolvePipelineByPublicRef: async () => null,
}));

import { GET as dealsGet } from "@/app/api/painel/deals/route";
import { GET as serviceGet } from "@/app/api/painel/service/route";
import { GET as teamGet } from "@/app/api/painel/team/route";
import { GET as tabulationsGet } from "@/app/api/analytics/tabulations/route";

/** `nome;dur=1.2;desc="x"` → { nome: { dur, desc } } (na ordem do cabeçalho). */
function phases(header: string | null) {
  expect(header).toBeTruthy();
  const out: Record<string, { dur: number; desc?: string }> = {};
  for (const part of header!.split(", ")) {
    const m = /^([A-Za-z-]+);dur=([\d.]+)(?:;desc="([^"]*)")?$/.exec(part);
    expect(m, `fase mal formada: ${part}`).toBeTruthy();
    out[m![1]] = { dur: Number(m![2]), desc: m![3] };
  }
  return out;
}

const url = (path: string, qs: Record<string, string>) =>
  new Request(`https://api.test${path}?${new URLSearchParams(qs)}`);

beforeEach(() => {
  h.replicaActive = false;
  h.role = "ADMIN";
  h.queryRaw.mockClear();
  h.dealCount.mockClear();
});

describe("Server-Timing — /api/painel/service", () => {
  it("auth, uma fase por seção que rodou, no_replica na pulada, serialize e total", async () => {
    const res = await serviceGet(
      url("/api/painel/service", { period: "last_7", section: "exceptions,heatmap,tempo" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exceptions.ok).toBe(true);
    expect(body.heatmap).toMatchObject({ ok: false, reason: "no_replica" });

    const p = phases(res.headers.get("server-timing"));
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining(["auth", "q-exceptions", "q-heatmap", "q-tempo", "serialize", "total"]),
    );
    // Pulada por falta de réplica: sem tempo, com o motivo; não pedida: não aparece.
    expect(p["q-heatmap"]).toEqual({ dur: 0, desc: "no_replica" });
    expect(p["q-tempo"]).toEqual({ dur: 0, desc: "no_replica" });
    expect(p["q-volume"]).toBeUndefined();
    expect(p["q-shared"]).toBeUndefined();
    expect(p["q-exceptions"].desc).toBeUndefined();
    expect(p.total.dur).toBeGreaterThanOrEqual(p["q-exceptions"].dur);
    expect(p.total.dur).toBeGreaterThanOrEqual(p.serialize.dur);
    // `total` é a última fase.
    expect(Object.keys(p).at(-1)).toBe("total");
  });

  it("com réplica: heatmap roda e mede q-heatmap sem desc", async () => {
    h.replicaActive = true;
    const res = await serviceGet(url("/api/painel/service", { section: "heatmap" }));
    const body = await res.json();
    expect(body.heatmap.ok).toBe(true);
    const p = phases(res.headers.get("server-timing"));
    expect(p["q-heatmap"].desc).toBeUndefined();
  });

  it("não muda o corpo: continua JSON com Content-Type application/json", async () => {
    const res = await serviceGet(url("/api/painel/service", { section: "exceptions" }));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(Object.keys(await res.json())).toEqual(
      expect.arrayContaining(["agora", "volume", "exceptions"]),
    );
  });
});

describe("Server-Timing — /api/painel/team (com cache)", () => {
  it("miss calcula (q-bloco, cache;desc=miss); a repetição é hit e não mede q-bloco", async () => {
    const req = () => url("/api/painel/team", { period: "last_7", section: "transfers" });

    const first = await teamGet(req());
    expect((await first.json()).transfers.ok).toBe(true);
    const p1 = phases(first.headers.get("server-timing"));
    expect(p1.cache.desc).toBe("miss");
    expect(p1["q-transfers"]).toBeDefined();
    expect(Object.keys(p1)).toEqual(expect.arrayContaining(["auth", "serialize", "total"]));

    h.queryRaw.mockClear();
    const second = await teamGet(req());
    const p2 = phases(second.headers.get("server-timing"));
    expect(p2.cache.desc).toBe("hit");
    expect(p2["q-transfers"]).toBeUndefined();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("MEMBER continua com 403 e sem tocar no banco", async () => {
    h.role = "MEMBER";
    const res = await teamGet(url("/api/painel/team", { period: "last_30" }));
    expect(res.status).toBe(403);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe("Server-Timing — /api/painel/deals", () => {
  it("auth, pipeline, q-bloco, serialize e total", async () => {
    const res = await dealsGet(url("/api/painel/deals", { period: "last_7", section: "exceptions" }));
    expect(res.status).toBe(200);
    expect((await res.json()).exceptions.ok).toBe(true);
    const p = phases(res.headers.get("server-timing"));
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining(["auth", "pipeline", "q-exceptions", "serialize", "total"]),
    );
    expect(p["q-kpis"]).toBeUndefined();
    expect(p.cache).toBeUndefined();
  });
});

describe("Server-Timing — /api/analytics/tabulations (com cache)", () => {
  it("miss mede query; hit só informa cache", async () => {
    const req = () =>
      url("/api/analytics/tabulations", {
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-05T00:00:00.000Z",
        page: "1",
      });

    const first = await tabulationsGet(req());
    expect(first.status).toBe(200);
    const p1 = phases(first.headers.get("server-timing"));
    expect(Object.keys(p1)).toEqual(
      expect.arrayContaining(["auth", "cache", "query", "serialize", "total"]),
    );
    expect(p1.cache.desc).toBe("miss");

    const second = await tabulationsGet(req());
    const p2 = phases(second.headers.get("server-timing"));
    expect(p2.cache.desc).toBe("hit");
    expect(p2.query).toBeUndefined();
    expect(await second.json()).toEqual(await first.json());
  });

  it("período cortado continua devolvendo rangeClamped", async () => {
    const res = await tabulationsGet(
      url("/api/analytics/tabulations", {
        from: "2020-01-01T00:00:00.000Z",
        to: "2026-10-05T00:00:00.000Z",
      }),
    );
    expect((await res.json()).rangeClamped).toBe(true);
    expect(phases(res.headers.get("server-timing")).serialize).toBeDefined();
  });

  it("MEMBER continua com 403", async () => {
    h.role = "MEMBER";
    const res = await tabulationsGet(url("/api/analytics/tabulations", {}));
    expect(res.status).toBe(403);
  });
});
