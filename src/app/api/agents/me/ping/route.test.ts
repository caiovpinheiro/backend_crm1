/**
 * POST /api/agents/me/ping — limite de 1 ping a cada 20 s por usuário e aba
 * (`x-tab-id`), com Redis falso em memória; fail-open com Redis fora.
 * Inatividade informada pelo cliente (`lastInteractionAt`) e `sessionIdleMs`.
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

function ping(tabId?: string, body?: unknown): Promise<Response> {
  return POST(
    new Request("https://api.test/api/agents/me/ping", {
      method: "POST",
      headers: {
        ...(tabId === undefined ? {} : { "x-tab-id": tabId }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  state = newFakeRedisState();
  const { default: FakeRedis } = fakeIoredisModule(state);
  h.client.current = new FakeRedis();
  h.user = { id: "u1", organizationId: "org1" };
  h.recordHeartbeatThrottled.mockResolvedValue({ created: false, written: true });
  delete process.env.SESSION_IDLE_HOURS;
  delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
  delete process.env.PRESENCE_PING_USER_MAX_PER_MIN;
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
    expect(await (await ping("aba-1")).json()).toEqual({
      ok: true,
      systemOnline: true,
      sessionIdleMs: 12 * HOUR,
    });
    expect((await ping("aba-1")).status).toBe(429);
    expect(h.recordHeartbeatThrottled).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/me/ping — lastInteractionAt (inatividade do cliente)", () => {
  it("interação há 13 h (ISO) → 401 SESSION_REVOKED reason idle, sem presença e sem gastar o limite", async () => {
    const res = await ping("aba-1", { lastInteractionAt: new Date(T0 - 13 * HOUR).toISOString() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "Sessão expirada. Entre novamente.",
      code: "SESSION_REVOKED",
      reason: "idle",
    });
    expect(h.recordHeartbeatThrottled).not.toHaveBeenCalled();
    // Nada no Redis: nem o limite do ping nem o registro de atividade.
    expect([...state.store.keys()]).toEqual([]);
  });

  it("epoch em ms também vale (número ou texto)", async () => {
    expect((await ping("aba-1", { lastInteractionAt: T0 - 13 * HOUR })).status).toBe(401);
    expect((await ping("aba-1", { lastInteractionAt: String(T0 - 13 * HOUR) })).status).toBe(401);
    expect(h.recordHeartbeatThrottled).not.toHaveBeenCalled();
  });

  it("interação recente → 200 com sessionIdleMs; presença gravada; o ping não renova a sessão", async () => {
    const res = await ping("aba-1", { lastInteractionAt: new Date(T0 - 5 * 60_000).toISOString() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      systemOnline: true,
      created: false,
      sessionIdleMs: 12 * HOUR,
    });
    expect(h.recordHeartbeatThrottled).toHaveBeenCalledTimes(1);
    expect([...state.store.keys()].some((k) => k.startsWith("auth:session-activity:"))).toBe(false);
  });

  it("valor no futuro ou ilegível → campo ignorado (200)", async () => {
    expect((await ping("aba-1", { lastInteractionAt: T0 + HOUR })).status).toBe(200);
    expect((await ping("aba-2", { lastInteractionAt: "ontem" })).status).toBe(200);
    expect((await ping("aba-3", { lastInteractionAt: null })).status).toBe(200);
    expect(h.recordHeartbeatThrottled).toHaveBeenCalledTimes(3);
  });

  it("sem corpo (cliente antigo) → 200 com sessionIdleMs", async () => {
    const res = await ping("aba-1");
    expect(res.status).toBe(200);
    expect((await res.json()).sessionIdleMs).toBe(12 * HOUR);
  });

  it("SESSION_IDLE_HOURS=0.05 (3 min): 4 min → 401; 2 min → 200 com sessionIdleMs 180000", async () => {
    process.env.SESSION_IDLE_HOURS = "0.05";
    expect((await ping("aba-1", { lastInteractionAt: T0 - 4 * 60_000 })).status).toBe(401);
    const res = await ping("aba-1", { lastInteractionAt: T0 - 2 * 60_000 });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionIdleMs).toBe(180_000);
  });
});

describe("POST /api/agents/me/ping — teto por usuário (todas as abas)", () => {
  it("7º ping no mesmo minuto (abas diferentes) → 429 com retryAfterMs coerente; depois da janela → 200", async () => {
    for (let i = 1; i <= 6; i++) {
      vi.setSystemTime(T0 + (i - 1) * 5_000);
      expect((await ping(`aba-${i}`)).status).toBe(200);
    }
    // 7º, 30 s depois do 1º: faltam 30 s da janela de 60 s.
    vi.setSystemTime(T0 + 30_000);
    const res = await ping("aba-7");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ retryAfterMs: 30_000 });
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(h.recordHeartbeatThrottled).toHaveBeenCalledTimes(6);

    // Outro usuário não é afetado.
    h.user = { id: "u2", organizationId: "org1" };
    expect((await ping("aba-1")).status).toBe(200);
    h.user = { id: "u1", organizationId: "org1" };

    // Janela vencida → volta a passar.
    vi.setSystemTime(T0 + 60_000);
    expect((await ping("aba-8")).status).toBe(200);
  });

  it("ping barrado pelo limite da aba não conta no teto do usuário", async () => {
    expect((await ping("aba-1")).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await ping("aba-1")).status).toBe(429);
    for (let i = 2; i <= 6; i++) expect((await ping(`aba-${i}`)).status).toBe(200);
    expect((await ping("aba-7")).status).toBe(429);
  });

  it("PRESENCE_PING_USER_MAX_PER_MIN muda o teto", async () => {
    process.env.PRESENCE_PING_USER_MAX_PER_MIN = "2";
    expect((await ping("aba-1")).status).toBe(200);
    expect((await ping("aba-2")).status).toBe(200);
    expect((await ping("aba-3")).status).toBe(429);
  });

  it("Redis fora ou ausente: fail-open", async () => {
    state.down = true;
    for (let i = 1; i <= 8; i++) expect((await ping(`aba-${i}`)).status).toBe(200);
    h.client.current = null;
    for (let i = 1; i <= 8; i++) expect((await ping(`aba-${i}`)).status).toBe(200);
  });
});
