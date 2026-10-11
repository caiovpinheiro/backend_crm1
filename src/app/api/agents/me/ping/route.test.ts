/**
 * POST /api/agents/me/ping — limite de 1 ping a cada 20 s por usuário e aba
 * (`x-tab-id`), com Redis falso em memória; fail-open com Redis fora.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeIoredisModule, newFakeRedisState } from "@/test-setup/fake-cache-redis";

const h = vi.hoisted(() => ({
  client: { current: null as unknown },
  user: { id: "u1", organizationId: "org1" as string | null },
  recordHeartbeatThrottled: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (handler: (s: unknown) => unknown) =>
    handler({ user: { ...h.user, isSuperAdmin: false } }),
}));
vi.mock("@/services/system-presence", () => ({
  recordHeartbeatThrottled: h.recordHeartbeatThrottled,
}));
vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => h.client.current,
  noteSuccess: vi.fn(),
  noteFailure: vi.fn(),
}));

import { POST } from "@/app/api/agents/me/ping/route";

const T0 = 1_800_000_000_000;
let state = newFakeRedisState();

function ping(tabId?: string): Promise<Response> {
  return POST(
    new Request("https://api.test/api/agents/me/ping", {
      method: "POST",
      headers: tabId === undefined ? {} : { "x-tab-id": tabId },
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  state = newFakeRedisState();
  const { default: FakeRedis } = fakeIoredisModule(state);
  h.client.current = new FakeRedis();
  h.user = { id: "u1", organizationId: "org1" };
  h.recordHeartbeatThrottled.mockResolvedValue({ created: false, written: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/agents/me/ping — limite por usuário e aba", () => {
  it("2 pings em 5 s na mesma aba → 2º 429 com retryAfterMs e Retry-After", async () => {
    expect((await ping("aba-1")).status).toBe(200);
    vi.setSystemTime(T0 + 5_000);
    const res = await ping("aba-1");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ retryAfterMs: 15_000 });
    expect(res.headers.get("Retry-After")).toBe("15");
    expect(h.recordHeartbeatThrottled).toHaveBeenCalledTimes(1);
  });

  it("abas diferentes do mesmo usuário → ambos 200", async () => {
    expect((await ping("aba-1")).status).toBe(200);
    expect((await ping("aba-2")).status).toBe(200);
  });

  it("após 20 s → 200 de novo", async () => {
    expect((await ping("aba-1")).status).toBe(200);
    vi.setSystemTime(T0 + 19_999);
    expect((await ping("aba-1")).status).toBe(429);
    vi.setSystemTime(T0 + 20_000);
    expect((await ping("aba-1")).status).toBe(200);
  });

  it("sem header x-tab-id: limite por usuário (e header inválido conta como sem aba)", async () => {
    expect((await ping()).status).toBe(200);
    expect((await ping()).status).toBe(429);
    expect((await ping("x".repeat(200))).status).toBe(429);
    // Outro usuário não é afetado.
    h.user = { id: "u2", organizationId: "org1" };
    expect((await ping()).status).toBe(200);
  });

  it("Redis fora ou ausente: fail-open (200)", async () => {
    expect((await ping("aba-1")).status).toBe(200);
    state.down = true;
    expect((await ping("aba-1")).status).toBe(200);
    h.client.current = null;
    expect((await ping("aba-1")).status).toBe(200);
  });

  it("super-admin sem org também é limitado, sem gravar presença", async () => {
    h.user = { id: "sa", organizationId: null };
    expect(await (await ping("aba-1")).json()).toEqual({ ok: true, systemOnline: true });
    expect((await ping("aba-1")).status).toBe(429);
    expect(h.recordHeartbeatThrottled).not.toHaveBeenCalled();
  });
});
