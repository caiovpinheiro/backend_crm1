/**
 * Métricas das respostas de inicialização no formato do `/api/metrics`:
 * hit/miss de cache por família e 304 vs 200.
 */
import { describe, expect, it } from "vitest";

import { metrics, recordCacheLookup, recordConditionalResponse } from "@/lib/metrics";

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
});
