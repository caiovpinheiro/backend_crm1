/**
 * `runInBackground`: agenda via `after()` do Next; fora de um escopo de
 * requisição roda solta; erro da tarefa nunca propaga.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: mocks.error }),
}));

import { runInBackground } from "@/lib/background";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runInBackground", () => {
  it("entrega a tarefa ao after() sem executá-la na hora", () => {
    const task = vi.fn().mockResolvedValue(undefined);
    runInBackground("x", task);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();
  });

  it("fora de escopo de requisição (after lança): roda solta", async () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const task = vi.fn().mockResolvedValue(undefined);
    expect(() => runInBackground("x", task)).not.toThrow();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("erro da tarefa é logado com o rótulo e não propaga", async () => {
    let scheduled: (() => Promise<void>) | null = null;
    mocks.after.mockImplementation((fn: () => Promise<void>) => {
      scheduled = fn;
    });
    runInBackground("auth.forgot-password", () => Promise.reject(new Error("smtp caiu")));
    await expect((scheduled as unknown as () => Promise<void>)()).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0][0]).toMatchObject({ label: "auth.forgot-password" });
  });
});
