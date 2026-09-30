/**
 * Invalidação dos contadores do inbox (sem Redis, fallback em memória).
 *
 * - `scheduleTabCountsInvalidation` coalesce numa janela de 15 s por org
 *   (leading + trailing): N mudanças de status viram no máximo 2 purgas.
 * - `conversations.ts` (assign/resolve em lote e mudança de status) passa
 *   por essa janela em vez de chamar `invalidateInboxTabCounts` direto —
 *   a chamada direta ignorava a janela e somava à purga do
 *   `conversation_updated` no SSE.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.REDIS_URL;
});

import { cache } from "@/lib/cache";
import {
  inboxTabCountsHistKey,
  inboxTabCountsKey,
  INBOX_TAB_COUNTS_FP_LENGTH,
  scheduleTabCountsInvalidation,
} from "@/lib/cache/keys";

const FP = "a".repeat(INBOX_TAB_COUNTS_FP_LENGTH);

async function seed(orgId: string) {
  await cache.set(inboxTabCountsKey(orgId, FP), { entrada: 1 }, 90);
  await cache.set(inboxTabCountsHistKey(orgId, FP), { todos: 9 }, 600);
}

async function active(orgId: string) {
  return cache.get(inboxTabCountsKey(orgId, FP));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleTabCountsInvalidation", () => {
  it("purga na hora, coalesce as seguintes e purga uma vez no fim da janela", async () => {
    await seed("org-a");
    scheduleTabCountsInvalidation("org-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(await active("org-a")).toBeUndefined();
    // Histórica fica: expira pelo TTL próprio.
    expect(await cache.get(inboxTabCountsHistKey("org-a", FP))).toEqual({ todos: 9 });

    await seed("org-a");
    scheduleTabCountsInvalidation("org-a");
    await vi.advanceTimersByTimeAsync(5_000);
    scheduleTabCountsInvalidation("org-a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await active("org-a")).toEqual({ entrada: 1 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await active("org-a")).toBeUndefined();
  });

  it("janela é por org; org nula é ignorada", async () => {
    await seed("org-b");
    await seed("org-c");
    scheduleTabCountsInvalidation("org-b");
    scheduleTabCountsInvalidation(null);
    scheduleTabCountsInvalidation(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(await active("org-b")).toBeUndefined();
    expect(await active("org-c")).toEqual({ entrada: 1 });
  });
});

describe("conversations.ts usa a janela de coalescência", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "services", "conversations.ts"),
    "utf8",
  );

  it("não chama invalidateInboxTabCounts direto", () => {
    expect(source).not.toMatch(/\binvalidateInboxTabCounts\s*\(/);
    expect(source).not.toMatch(/\binvalidateInboxTabCounts\b/);
  });

  it("assign/resolve em lote e mudança de status agendam a invalidação", () => {
    const calls = source.match(/\bscheduleTabCountsInvalidation\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
