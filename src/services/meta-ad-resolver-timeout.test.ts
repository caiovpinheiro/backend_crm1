/**
 * RT-17: fetch ao Graph com `AbortSignal.timeout`; TimeoutError vira
 * status "error" (falha de resolução), não exceção.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { contactUpdate, contactFindUnique, contactFindFirst } = vi.hoisted(() => ({
  contactUpdate: vi.fn(async (_args?: unknown) => ({})),
  contactFindUnique: vi.fn(async (_args?: unknown) => null),
  contactFindFirst: vi.fn(async (_args?: unknown) => null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      update: contactUpdate,
      findUnique: contactFindUnique,
      findFirst: contactFindFirst,
    },
  },
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/meta-graph-version", () => ({ getMetaGraphApiVersion: () => "v21.0" }));

import {
  AD_RESOLVER_FETCH_TIMEOUT_MS,
  resolveAdAndPersistAsync,
} from "@/services/meta-ad-resolver";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  contactUpdate.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("meta-ad-resolver fetch timeout", () => {
  it("passa um AbortSignal com timeout para o Graph", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "ad_1", name: "Ad" }), { status: 200 }),
    );
    await resolveAdAndPersistAsync({
      contactId: "c1",
      organizationId: "org_1",
      sourceId: "ad_1",
      sourceType: "ad",
      accessToken: "tok",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(AD_RESOLVER_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(AD_RESOLVER_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("TimeoutError vira status error persistido (sem exceção)", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValue(err);
    await expect(
      resolveAdAndPersistAsync({
        contactId: "c1",
        organizationId: "org_1",
        sourceId: "post_1",
        sourceType: "post",
        accessToken: "tok",
      }),
    ).resolves.toBeUndefined();
    const statuses = contactUpdate.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data.adResolveStatus,
    );
    expect(statuses).toContain("error");
    const errors = contactUpdate.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data.adResolveError,
    );
    expect(errors.some((e) => typeof e === "string" && e.includes("timeout"))).toBe(true);
  });
});
