import { describe, expect, it } from "vitest";

import { mergeDashboardLayoutData } from "@/lib/dashboard-layout-merge";

const existing = {
  visibleWidgets: ["kpis"],
  layout: { kpis: { i: "kpis", x: 0, y: 0, w: 4, h: 2 } },
  meta: {
    v: 2,
    negocios: { version: 2, cards: ["a"] },
    service: { order: ["agora"], hidden: [] },
    operator: { order: ["kpis"], hidden: ["tasks"] },
    filters: { period: "today", pipelineIds: ["p1"] },
  },
};

describe("mergeDashboardLayoutData", () => {
  it("salvar service não apaga negocios nem os outros slices", () => {
    const merged = mergeDashboardLayoutData(existing, {
      meta: { v: 2, service: { order: ["volume"], hidden: ["agora"] } },
    });
    expect(merged.meta.service).toEqual({ order: ["volume"], hidden: ["agora"] });
    expect(merged.meta.negocios).toEqual(existing.meta.negocios);
    expect(merged.meta.operator).toEqual(existing.meta.operator);
    expect(merged.meta.filters).toEqual(existing.meta.filters);
    expect(merged.meta.v).toBe(2);
    expect(merged.visibleWidgets).toEqual(["kpis"]);
    expect(merged.layout).toEqual(existing.layout);
  });

  it("salvar ui não apaga outros estados e mantém meta.v = 2", () => {
    const merged = mergeDashboardLayoutData(existing, {
      meta: { ui: { tab: "service", clock: "elapsed" } },
    });
    expect(merged.meta.ui).toEqual({ tab: "service", clock: "elapsed" });
    expect(merged.meta.negocios).toEqual(existing.meta.negocios);
    expect(merged.meta.service).toEqual(existing.meta.service);
    expect(merged.meta.operator).toEqual(existing.meta.operator);
    expect(merged.meta.filters).toEqual(existing.meta.filters);
    expect(merged.meta.v).toBe(2);
  });

  it("ignora organizationId e userId dentro do meta", () => {
    const merged = mergeDashboardLayoutData(existing, {
      meta: { organizationId: "evil", userId: "evil", ui: { tab: "deals" } },
    });
    expect(merged.meta.organizationId).toBeUndefined();
    expect(merged.meta.userId).toBeUndefined();
    expect(merged.meta.ui).toEqual({ tab: "deals" });
    expect(merged.meta.negocios).toEqual(existing.meta.negocios);
  });

  it("registro vazio recebe v: 2 sem apagar o slice novo", () => {
    const merged = mergeDashboardLayoutData(null, {
      meta: { negocios: { version: 2 } },
    });
    expect(merged.meta).toEqual({ v: 2, negocios: { version: 2 } });
    expect(merged.visibleWidgets).toEqual([]);
    expect(merged.layout).toEqual({});
  });
});
