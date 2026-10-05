/**
 * C1 da auditoria de banco (05/10) — contagem de consultas das tabelas
 * pequenas lidas a cada requisição: `organization_widgets`, `pipelines` e
 * `organizations`.
 *
 * Mede com a sonda de I/O (`io-probe`): cada chamada ao cliente Prisma é
 * uma "consulta". Os números de "antes" estão nos comentários de cada
 * teste (uma consulta por chamada, como o código fazia).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  delete process.env.CACHE_VERSION_MEMO_MS;
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/prisma", async () => {
  const { probe } = await import("@/test-setup/io-probe");
  return { prisma: probe.prisma };
});

vi.mock("@/lib/prisma-base", async () => {
  const { probe } = await import("@/test-setup/io-probe");
  return { prismaBase: probe.prisma };
});

vi.mock("@/services/deal-duplicates", () => ({
  duplicateDealsErrorMessage: () => null,
  invalidatePipelineBoard: async () => undefined,
  unifyDuplicateOpenDealsInPipeline: async () => 0,
}));

import { resetLocalVersionedForTests } from "@/lib/cache/local-versioned";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import { runWithContext, type RequestContext } from "@/lib/request-context";
import {
  getOrganizationSummary,
  invalidateOrganizationSummary,
} from "@/services/organization-summary";
import {
  getActiveWidgetSlugs,
  hasOrganizationWidget,
  installWidget,
  uninstallWidget,
} from "@/services/organization-widgets";
import {
  ensureDefaultPipeline,
  getDefaultPipelineId,
  getPipelineMeta,
  resolvePipelineByPublicRef,
  updatePipeline,
} from "@/services/pipelines";
import { probe } from "@/test-setup/io-probe";

const PIPELINE_ID = "cku1a2b3c4d5e6f7g8h9i0j1k";
const PIPELINES = [
  { id: PIPELINE_ID, number: 1, slug: "vendas", name: "Vendas", isDefault: true },
  { id: "cku9z8y7x6w5v4u3t2s1r0q9p", number: 2, slug: "pos-venda", name: "Pós-venda", isDefault: false },
];

function ctx(organizationId: string): RequestContext {
  return { organizationId, isSuperAdmin: false } as RequestContext;
}

function inOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(runWithContext(ctx(organizationId), fn));
}

/** Consultas ao Postgres de uma execução, por rótulo (`modelo.operação`). */
async function pgCalls(fn: () => Promise<unknown>): Promise<string[]> {
  const { entries } = await probe.run(fn);
  return entries.filter((e) => e.kind === "pg").map((e) => e.label);
}

let activeWidgets: Record<string, string[]>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  resetCacheVersionsForTests();
  resetLocalVersionedForTests();
  probe.reset();
  activeWidgets = { org_1: ["smart_distribution"], org_2: [] };
  probe.setDbHandler((model, operation) => {
    if (model === "organizationWidget" && operation === "findMany") {
      // O teste roda com um contexto por chamada; a org vem do AsyncLocalStorage.
      return (activeWidgets[currentOrg] ?? []).map((widgetSlug) => ({ widgetSlug }));
    }
    if (model === "widget" && operation === "findUnique") {
      return { slug: "calls_history", status: "ONLINE", availability: "available", ownerType: "INTERNAL" };
    }
    if (model === "pipeline" && operation === "findMany") return PIPELINES;
    if (model === "pipeline" && operation === "count") return PIPELINES.length;
    if (model === "pipeline" && operation === "update") return { id: PIPELINE_ID, stages: [] };
    if (model === "organization" && operation === "findUnique") {
      return {
        id: "org_1",
        name: "Org Um",
        slug: "org-um",
        logoUrl: null,
        primaryColor: null,
        status: orgStatus,
        onboardingCompletedAt: null,
      };
    }
    return undefined;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

let currentOrg = "org_1";
let orgStatus = "ACTIVE";

function widgetsOf<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return inOrg(organizationId, async () => {
    currentOrg = organizationId;
    return fn();
  });
}

describe("organization_widgets — gate de widget em memória", () => {
  it("50 checagens do gate = 1 consulta (antes: 50)", async () => {
    const calls = await pgCalls(() =>
      widgetsOf("org_1", async () => {
        for (let i = 0; i < 50; i++) {
          expect(await hasOrganizationWidget("smart_distribution")).toBe(true);
        }
        expect(await hasOrganizationWidget("calls_history")).toBe(false);
        expect([...(await getActiveWidgetSlugs())]).toEqual(["smart_distribution"]);
      }),
    );
    expect(calls).toEqual(["organizationWidget.findMany"]);
  });

  it("volta ao banco depois de 30 s", async () => {
    await pgCalls(() => widgetsOf("org_1", () => hasOrganizationWidget("smart_distribution")));
    await vi.advanceTimersByTimeAsync(30_001);
    const calls = await pgCalls(() =>
      widgetsOf("org_1", () => hasOrganizationWidget("smart_distribution")),
    );
    expect(calls).toEqual(["organizationWidget.findMany"]);
  });

  it("uma org não responde pela outra", async () => {
    const one = await probe.run(() =>
      widgetsOf("org_1", () => hasOrganizationWidget("smart_distribution")),
    );
    const two = await probe.run(() =>
      widgetsOf("org_2", () => hasOrganizationWidget("smart_distribution")),
    );
    expect(one.result).toBe(true);
    expect(two.result).toBe(false);
  });

  it("instalar e desinstalar valem na leitura seguinte", async () => {
    await probe.run(() => widgetsOf("org_2", () => hasOrganizationWidget("calls_history")));

    activeWidgets.org_2 = ["calls_history"];
    await probe.run(() => widgetsOf("org_2", () => installWidget("calls_history", "u_1")));
    const afterInstall = await probe.run(() =>
      widgetsOf("org_2", () => hasOrganizationWidget("calls_history")),
    );
    expect(afterInstall.result).toBe(true);

    activeWidgets.org_2 = [];
    await probe.run(() => widgetsOf("org_2", () => uninstallWidget("calls_history")));
    const afterUninstall = await probe.run(() =>
      widgetsOf("org_2", () => hasOrganizationWidget("calls_history")),
    );
    expect(afterUninstall.result).toBe(false);
  });

  it("quem recebe o conjunto não altera o que está em memória", async () => {
    await probe.run(() =>
      widgetsOf("org_1", async () => {
        const mine = await getActiveWidgetSlugs();
        mine.add("inventado");
        expect(await hasOrganizationWidget("inventado")).toBe(false);
      }),
    );
  });

  it("sem org no contexto (super-admin cross-org) consulta direto, sem guardar", async () => {
    const calls = await pgCalls(async () => {
      await hasOrganizationWidget("smart_distribution");
      await hasOrganizationWidget("smart_distribution");
    });
    expect(calls).toEqual(["organizationWidget.findMany", "organizationWidget.findMany"]);
  });
});

describe("pipelines — ref público, meta e funil padrão em memória", () => {
  it("abrir o board 20 vezes = 1 consulta em pipelines (antes: 20 em série + meta)", async () => {
    const calls = await pgCalls(() =>
      inOrg("org_1", async () => {
        for (let i = 0; i < 20; i++) {
          const byNumber = await resolvePipelineByPublicRef("1");
          const bySlug = await resolvePipelineByPublicRef("pos-venda");
          const byId = await resolvePipelineByPublicRef(PIPELINE_ID);
          const byName = await resolvePipelineByPublicRef("vendas");
          expect(byNumber).toEqual({ id: PIPELINE_ID, number: 1, slug: "vendas", name: "Vendas" });
          expect(bySlug?.number).toBe(2);
          expect(byId?.id).toBe(PIPELINE_ID);
          expect(byName?.id).toBe(PIPELINE_ID);
          expect(await getPipelineMeta(PIPELINE_ID)).toEqual({
            id: PIPELINE_ID,
            name: "Vendas",
            slug: "vendas",
            number: 1,
            isDefault: true,
          });
          expect(await getDefaultPipelineId()).toBe(PIPELINE_ID);
          await ensureDefaultPipeline();
        }
      }),
    );
    expect(calls).toEqual(["pipeline.findMany"]);
  });

  it("ref que não está na memória vai ao banco (funil recém-criado em outra réplica)", async () => {
    const calls = await pgCalls(() =>
      inOrg("org_1", async () => {
        expect(await resolvePipelineByPublicRef("99")).toBeNull();
        expect(await getPipelineMeta("ckuNaoExiste0000000000000")).toBeNull();
      }),
    );
    expect(calls).toEqual(["pipeline.findMany", "pipeline.findFirst", "pipeline.findFirst"]);
  });

  it("editar o funil invalida a lista", async () => {
    await probe.run(() => inOrg("org_1", () => resolvePipelineByPublicRef("1")));
    await probe.run(() => inOrg("org_1", () => updatePipeline(PIPELINE_ID, { isDefault: true })));
    const calls = await pgCalls(() => inOrg("org_1", () => resolvePipelineByPublicRef("1")));
    expect(calls).toEqual(["pipeline.findMany"]);
  });
});

describe("organizations — dados básicos em memória", () => {
  it("20 leituras = 1 consulta (antes: 20); edição vale na leitura seguinte", async () => {
    orgStatus = "ACTIVE";
    const calls = await pgCalls(async () => {
      for (let i = 0; i < 20; i++) {
        expect((await getOrganizationSummary("org_1"))?.status).toBe("ACTIVE");
      }
    });
    expect(calls).toEqual(["organization.findUnique"]);

    orgStatus = "SUSPENDED";
    await probe.run(() => invalidateOrganizationSummary("org_1"));
    const after = await probe.run(() => getOrganizationSummary("org_1"));
    expect(after.result?.status).toBe("SUSPENDED");
  });

  it("sem invalidação, o status antigo dura no máximo 30 s", async () => {
    orgStatus = "ACTIVE";
    await probe.run(() => getOrganizationSummary("org_1"));
    orgStatus = "SUSPENDED";
    await vi.advanceTimersByTimeAsync(30_001);
    const after = await probe.run(() => getOrganizationSummary("org_1"));
    expect(after.result?.status).toBe("SUSPENDED");
  });
});
