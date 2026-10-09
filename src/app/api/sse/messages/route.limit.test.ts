/**
 * GET /api/sse/messages — teto de conexões (SSE-2), com o módulo de
 * contagem mockado (ele tem teste próprio com Redis falso).
 *
 * - Teto da org: 429 com Retry-After, sem abrir stream nem assinar o bus.
 * - Teto por usuário: a conexão evictada recebe `sse_connection_evicted`
 *   (com `retry:`) e fecha; o slot é liberado.
 * - Heartbeat renova a entrada; teardown libera o slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  acquire: vi.fn(),
  heartbeat: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  onEvict: null as null | (() => void),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({
  loadAuthzContext: vi.fn(),
  canViewPipeline: () => true,
  canViewStage: () => true,
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/authz/funnel-visibility", () => ({
  conversationBlockedByFunnel: vi.fn(),
  funnelScopeOf: () => null,
}));
vi.mock("@/lib/browser-api-cors-node", () => ({ applyBrowserApiCors: async () => undefined }));
vi.mock("@/lib/inbox-sse-card-visibility", () => ({
  allowAllInboxSseCards: () => true,
  buildInboxSseCardGate: vi.fn(async () => () => true),
  stripHiddenInboxSseCard: (data: unknown) => data,
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/request-context", () => ({
  runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/sse-membership-watch", () => ({
  watchSseMembership: () => () => undefined,
}));
vi.mock("@/lib/sse-bus", () => ({
  SSE_ACCESS_REVOKED: "sse_access_revoked",
  encodeSseFrame: (event: string, data: unknown) =>
    new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
  sseBus: { subscribe: mocks.subscribe },
}));
vi.mock("@/lib/sse-connection-limit", () => ({
  SSE_EVICTED_EVENT: "sse_connection_evicted",
  SSE_HEARTBEAT_MS: 25_000,
  acquireSseConnection: mocks.acquire,
}));

import { GET } from "@/app/api/sse/messages/route";

function okSlot() {
  return {
    ok: true,
    slot: { connId: "conn-1", heartbeat: mocks.heartbeat, release: mocks.release },
  };
}

async function open() {
  const res = await GET(new Request("https://api.test/api/sse/messages"));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => {
    const chunk = await reader.read();
    return chunk.done ? null : decoder.decode(chunk.value);
  };
  expect(await next()).toBe(": connected\n\n");
  return { reader, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onEvict = null;
  mocks.auth.mockResolvedValue({
    user: { id: "u1", role: "MEMBER", organizationId: "org1", isSuperAdmin: false },
  });
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe);
  mocks.acquire.mockImplementation(async (args: { onEvict: () => void }) => {
    mocks.onEvict = args.onEvict;
    return okSlot();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/sse/messages — teto de conexões", () => {
  it("teto da org: 429 com Retry-After, sem stream nem assinatura", async () => {
    mocks.acquire.mockResolvedValue({
      ok: false,
      reason: "org_limit",
      retryAfterSec: 35,
      count: 200,
      limit: 200,
    });
    const res = await GET(new Request("https://api.test/api/sse/messages"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("35");
    expect(await res.text()).toMatch(/Limite de conexões/);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("registra a conexão com o usuário e a org da sessão", async () => {
    const { reader } = await open();
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", organizationId: "org1" }),
    );
    await reader.cancel();
  });

  it("evicção: manda sse_connection_evicted com retry e fecha, liberando o slot", async () => {
    const { next } = await open();
    expect(mocks.onEvict).not.toBeNull();
    mocks.onEvict!();
    const frame = await next();
    expect(frame).toContain("retry: 50000\n");
    expect(frame).toContain("event: sse_connection_evicted\n");
    expect(frame).toContain('"reason":"user_limit"');
    expect(await next()).toBeNull();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("heartbeat renova a entrada a cada 25 s; cancelar libera o slot", async () => {
    vi.useFakeTimers();
    const { reader, next } = await open();
    await vi.advanceTimersByTimeAsync(25_000);
    // Comentário (keepalive de proxy) + evento nomeado que o EventSource
    // entrega ao `use-sse` (detecção de conexão travada).
    expect(await next()).toBe(": heartbeat\n\nevent: heartbeat\ndata: {}\n\n");
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();
    await reader.cancel();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("evicção antes de o stream começar fecha na abertura", async () => {
    mocks.acquire.mockImplementation(async (args: { onEvict: () => void }) => {
      args.onEvict();
      return okSlot();
    });
    const res = await GET(new Request("https://api.test/api/sse/messages"));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: sse_connection_evicted");
    expect((await reader.read()).done).toBe(true);
    expect(mocks.release).toHaveBeenCalled();
  });
});
