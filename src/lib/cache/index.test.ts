/**
 * Cache-aside sem Redis: singleflight e persistencia via memoria.
 */
import { describe, expect, it } from "vitest";

import { cache } from "@/lib/cache";
import { boardDataKey, shouldInvalidateInboxTabCounts } from "@/lib/cache/keys";

describe("cache.wrap singleflight", () => {
  it("chamadas concorrentes da mesma chave disparam o loader uma vez", async () => {
    const key = `sf:${Date.now()}:${Math.random()}`;
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 40));
      return { loads };
    };
    const [a, b, c] = await Promise.all([
      cache.wrap(key, 30, loader),
      cache.wrap(key, 30, loader),
      cache.wrap(key, 30, loader),
    ]);
    expect(loads).toBe(1);
    expect(a).toEqual({ loads: 1 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe("cache fallback memoria", () => {
  it("grava e le payload grande via wrap/get", async () => {
    const key = `gz:${Date.now()}:${Math.random()}`;
    const payload = { blob: "x".repeat(12_000), n: 7 };
    const stored = await cache.wrap(key, 30, async () => payload);
    expect(stored.n).toBe(7);
    const hit = await cache.get<typeof payload>(key);
    expect(hit?.blob.length).toBe(12_000);
    expect(hit?.n).toBe(7);
  });
});

describe("shouldInvalidateInboxTabCounts", () => {
  const org = { organizationId: "org1", conversationId: "c1" };

  it("não invalida new_message (preview / last message)", () => {
    expect(
      shouldInvalidateInboxTabCounts("new_message", {
        ...org,
        direction: "in",
        content: "oi",
      }),
    ).toBe(false);
  });

  it("invalida conversation_updated só com campos de aba", () => {
    expect(shouldInvalidateInboxTabCounts("conversation_updated", org)).toBe(
      false,
    );
    expect(
      shouldInvalidateInboxTabCounts("conversation_updated", {
        ...org,
        assignedToId: "u1",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_updated", {
        ...org,
        assignedTo: null,
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_updated", {
        ...org,
        status: "RESOLVED",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_updated", {
        ...org,
        followUpAt: "2026-09-02T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_updated", {
        ...org,
        departmentId: "d1",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_updated", {
        ...org,
        whatsappCallConsentStatus: "GRANTED",
      }),
    ).toBe(true);
  });

  it("invalida timeline que move aba; ignora tabulação", () => {
    expect(
      shouldInvalidateInboxTabCounts("conversation_timeline_updated", {
        ...org,
        type: "ASSIGNEE_CHANGED",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_timeline_updated", {
        ...org,
        type: "CONVERSATION_CLOSED",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_timeline_updated", {
        ...org,
        type: "CONVERSATION_REOPENED",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_timeline_updated", {
        ...org,
        type: "CONVERSATION_DEPARTMENT_CHANGED",
      }),
    ).toBe(true);
    expect(
      shouldInvalidateInboxTabCounts("conversation_timeline_updated", {
        ...org,
        type: "CONVERSATION_TABULATED",
      }),
    ).toBe(false);
  });
});

describe("boardDataKey", () => {
  it("hasheia a variant — chave curta e estavel", () => {
    const variant = JSON.stringify({
      v: {},
      s: "ALL",
      f: { dealCustomFields: [{ name: "atualizado" }] },
      l: { perStage: 50 },
    });
    const a = boardDataKey("org1", "pipe1", variant);
    const b = boardDataKey("org1", "pipe1", variant);
    expect(a).toBe(b);
    expect(a).toMatch(/^board:org1:pipe1:[a-f0-9]{20}$/);
    expect(a.length).toBeLessThan(80);
    expect(a.includes(variant)).toBe(false);
  });
});
