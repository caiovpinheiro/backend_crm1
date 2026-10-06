/**
 * `cachedReport`: sem Redis (fallback em memória), chamadas idênticas
 * simultâneas dividem um loader, parâmetros equivalentes caem na mesma chave e
 * erro não é gravado.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { cachedReport } from "@/lib/report-cache";

const from = new Date("2026-10-06T12:00:10.000Z");

describe("cachedReport", () => {
  it("junta requisições idênticas simultâneas e reaproveita o resultado", async () => {
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { n: 1 };
    });
    const parts = { from, userIds: ["b", "a"] };
    const [a, b] = await Promise.all([
      cachedReport("t1", "org-1", parts, loader),
      // Mesmos parâmetros escritos de outro jeito: ids em outra ordem, segundos diferentes.
      cachedReport("t1", "org-1", { from: new Date(from.getTime() + 20_000), userIds: ["a", "b"] }, loader),
    ]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    await cachedReport("t1", "org-1", parts, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("separa por organização e por parâmetro", async () => {
    const loader = vi.fn(async () => ({ ok: true }));
    await cachedReport("t2", "org-1", { x: 1 }, loader);
    await cachedReport("t2", "org-2", { x: 1 }, loader);
    await cachedReport("t2", "org-1", { x: 2 }, loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("não grava quando o loader falha", async () => {
    const loader = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    await expect(cachedReport("t3", "org-1", {}, loader)).rejects.toThrow("boom");
    await expect(cachedReport("t3", "org-1", {}, loader)).resolves.toEqual({ ok: true });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
