/**
 * Métricas do limite por classe de custo no formato do `/api/metrics`:
 * rejeições por classe (429/503), hit/miss de cache por família, 304 vs 200
 * e atraso do event loop (p50/p99) + nível de sobrecarga.
 */
import { afterEach, describe, expect, it } from "vitest";

import { OverloadGuard, getOverloadConfig, setOverloadGuardForTests } from "@/lib/overload-guard";
import {
  metrics,
  recordCacheLookup,
  recordConditionalResponse,
  renderMetrics,
} from "@/lib/metrics";

afterEach(() => {
  setOverloadGuardForTests(null);
});

async function counterValue(
  c: { get: () => Promise<{ values: Array<{ labels: Record<string, unknown>; value: number }> }> },
  labels: Record<string, string>,
): Promise<number> {
  const { values } = await c.get();
  return (
    values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0
  );
}

describe("métricas do limite por custo", () => {
  it("recordCacheLookup reaproveita crm_cache_hits_total / crm_cache_misses_total por família", async () => {
    const hits0 = await counterValue(metrics.cacheHits, { key: "bootstrap" });
    const miss0 = await counterValue(metrics.cacheMisses, { key: "bootstrap" });
    recordCacheLookup("bootstrap", true);
    recordCacheLookup("bootstrap", true);
    recordCacheLookup("bootstrap", false);
    expect((await counterValue(metrics.cacheHits, { key: "bootstrap" })) - hits0).toBe(2);
    expect((await counterValue(metrics.cacheMisses, { key: "bootstrap" })) - miss0).toBe(1);
  });

  it("recordConditionalResponse conta 304 vs 200 por rota templatizada", async () => {
    const route = "/api/pipelines/:id";
    const before304 = await counterValue(metrics.apiCost.conditionalResponses, {
      route,
      status: "304",
    });
    recordConditionalResponse("/api/pipelines/12345", 304);
    recordConditionalResponse("/api/pipelines/67890", 304);
    recordConditionalResponse("/api/pipelines/12345", 200);
    expect(
      (await counterValue(metrics.apiCost.conditionalResponses, { route, status: "304" })) -
        before304,
    ).toBe(2);
    expect(
      await counterValue(metrics.apiCost.conditionalResponses, { route, status: "200" }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("/api/metrics expõe rejeições por classe, 304/200, p50/p99 do event loop e o nível", async () => {
    const guard = new OverloadGuard(
      () => ({ p50Ms: 12, p99Ms: 240 }),
      () => 1_000,
      () => getOverloadConfig({}),
    );
    guard.tick();
    setOverloadGuardForTests(guard);
    metrics.apiCost.rejections.inc({ class: "heavy_read", status: "429" });
    metrics.apiCost.rejections.inc({ class: "accessory", status: "503" });

    const { body } = await renderMetrics();
    expect(body).toMatch(/crm_api_cost_rejections_total\{class="heavy_read",status="429"[^}]*\} \d+/);
    expect(body).toMatch(/crm_api_cost_rejections_total\{class="accessory",status="503"[^}]*\} \d+/);
    expect(body).toContain("# TYPE crm_http_conditional_responses_total counter");
    expect(body).toMatch(/crm_event_loop_delay_ms\{quantile="0.5"[^}]*\} 12/);
    expect(body).toMatch(/crm_event_loop_delay_ms\{quantile="0.99"[^}]*\} 240/);
    expect(body).toMatch(/crm_overload_level\{[^}]*\} 1/);
  });
});
