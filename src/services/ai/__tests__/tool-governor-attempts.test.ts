import { describe, expect, it } from "vitest";
import { ToolCallGovernor } from "../tool-governor";

describe("governador: tentativas do mesmo turno", () => {
  it("startAttempt recomeça os tetos e devolve o já consultado sem aviso; repetição na mesma tentativa continua avisada", () => {
    const g = new ToolCallGovernor({ maxToolCallsPerRun: 6, maxRepeatsPerTool: 2 });
    g.startAttempt();
    expect(g.decide("search_products", { query: "a" })).toEqual({ action: "run" });
    g.record("search_products", { query: "a" }, { ok: 1 });
    expect(g.decide("search_products", { query: "b" })).toEqual({ action: "run" });
    g.record("search_products", { query: "b" }, { ok: 2 });
    expect(g.decide("search_products", { query: "c" })).toMatchObject({ action: "deny" });
    expect(g.deniedThisAttempt()).toBe(true);

    g.startAttempt();
    expect(g.deniedThisAttempt()).toBe(false);
    expect(g.decide("search_products", { query: "a" })).toEqual({ action: "reuse", previousResult: { ok: 1 } });
    expect(g.decide("search_products", { query: "a" })).toMatchObject({ action: "replay" });
    expect(g.decide("search_products", { query: "z" })).toEqual({ action: "run" });
    expect(g.stats().limitHit).toBe(true);
  });
});
