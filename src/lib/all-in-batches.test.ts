import { describe, expect, it } from "vitest";
import { allInBatches } from "./all-in-batches";

describe("allInBatches", () => {
  it("preserva ordem e tipos da tupla", async () => {
    const [a, b, c] = await allInBatches(
      [async () => 1, async () => "x", async () => true] as const,
      2,
    );
    expect([a, b, c]).toEqual([1, "x", true]);
  });

  it("nunca excede o tamanho do lote em paralelo", async () => {
    let running = 0;
    let peak = 0;
    const task = () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return 1;
    };
    await allInBatches(Array.from({ length: 10 }, task), 4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("propaga a rejeição", async () => {
    await expect(
      allInBatches([async () => 1, async () => { throw new Error("boom"); }], 2),
    ).rejects.toThrow("boom");
  });
});
