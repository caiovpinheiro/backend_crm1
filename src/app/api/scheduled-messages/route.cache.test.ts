/**
 * `GET /api/scheduled-messages?conversationId=` — ETag e 304 (gate de carga
 * de 15/10, metas 6 e 7).
 *
 *   - 200 com `ETag` / `Cache-Control: private, no-cache` / `Vary`;
 *     `If-None-Match` igual → 304 sem ler a lista;
 *   - bump (criar/cancelar/enviar/falhar) ou `rc_users` → 200 de novo;
 *   - outra org: 404, nunca 304; mesmo id de conversa em orgs diferentes
 *     não colide;
 *   - o bump feito em outra réplica vale na leitura seguinte (sem memória
 *     local da versão — bem abaixo de 5 s).
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
    session: {
      user: { id: "user_1", organizationId: "org_a", role: "MEMBER", isSuperAdmin: false },
    },
    /** Conversas visíveis por org (o resto é 404). */
    visible: new Map<string, Set<string>>(),
    list: vi.fn(async (conversationId: string) => [{ id: `sm_${conversationId}` }]),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (fn: (session: typeof h.session) => Promise<unknown>) => fn(h.session),
}));
vi.mock("@/lib/conversation-access", () => ({
  CONVERSATION_ACCESS_SELECT: { id: true, organizationId: true },
  requireConversationAccess: vi.fn(async () => null),
  requireConversationAccessAndLoad: async (
    session: typeof h.session,
    id: string,
  ) => {
    const org = session.user.organizationId;
    if (!h.visible.get(org)?.has(id)) {
      return {
        response: NextResponse.json(
          { message: "Conversa não encontrada ou sem permissão." },
          { status: 404 },
        ),
      };
    }
    return { conversation: { id, organizationId: org } };
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/scheduled-messages", () => ({
  listPendingByConversation: h.list,
  createScheduledMessage: vi.fn(),
  ScheduledMessageValidationError: class extends Error {},
}));

import { GET } from "@/app/api/scheduled-messages/route";
import { bumpResponseFamilies, RESPONSE_FAMILIES } from "@/lib/cache/response-families";
import { bumpScheduledMessages } from "@/lib/cache/scheduled-versions";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";

function get(conversationId: string, ifNoneMatch?: string) {
  return GET(
    new Request(`http://localhost/api/scheduled-messages?conversationId=${conversationId}`, {
      headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
    }),
  );
}

function as(org: string) {
  h.session = { user: { ...h.session.user, organizationId: org } };
}

beforeEach(() => {
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  resetCacheVersionsForTests();
  h.list.mockClear();
  h.visible = new Map([
    ["org_a", new Set(["conv_1", "conv_2"])],
    ["org_b", new Set(["conv_1"])],
  ]);
  as("org_a");
});

describe("GET /api/scheduled-messages — ETag e 304", () => {
  it("200 com ETag; If-None-Match igual → 304 sem ler a lista", async () => {
    const first = await get("conv_1");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"s\.[0-9a-f]{24}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("Cookie");
    expect(await first.json()).toEqual({ items: [{ id: "sm_conv_1" }] });
    expect(h.list).toHaveBeenCalledTimes(1);

    const again = await get("conv_1", etag);
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("agendada criada/cancelada/enviada (bump) → 200 com ETag novo", async () => {
    const etag = (await get("conv_1")).headers.get("etag")!;
    await bumpScheduledMessages("org_a", "conv_1");
    const after = await get("conv_1", etag);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("bump de outra conversa não invalida esta", async () => {
    const etag = (await get("conv_1")).headers.get("etag")!;
    await bumpScheduledMessages("org_a", "conv_2");
    expect((await get("conv_1", etag)).status).toBe(304);
  });

  it("usuário editado (nome/avatar de quem agendou) → 200", async () => {
    const etag = (await get("conv_1")).headers.get("etag")!;
    await bumpResponseFamilies("org_a", RESPONSE_FAMILIES.users);
    expect((await get("conv_1", etag)).status).toBe(200);
  });

  it("outra org: 404, nunca 304 — mesmo com o ETag certo", async () => {
    const etag = (await get("conv_2")).headers.get("etag")!;
    as("org_b");
    const res = await get("conv_2", etag);
    expect(res.status).toBe(404);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("mesmo id de conversa em duas orgs não colide (ETag nem versão)", async () => {
    const a = (await get("conv_1")).headers.get("etag")!;
    as("org_b");
    const b = (await get("conv_1")).headers.get("etag")!;
    expect(a).not.toBe(b);
    // ETag da org A não serve na org B.
    expect((await get("conv_1", a)).status).toBe(200);
    // Bump na org B não mexe na A.
    await bumpScheduledMessages("org_b", "conv_1");
    as("org_a");
    expect((await get("conv_1", a)).status).toBe(304);
  });

  it("bump em outra réplica vale na leitura seguinte (sem memória local)", async () => {
    const etag = (await get("conv_1")).headers.get("etag")!;
    vi.resetModules();
    const replica = await import("@/lib/cache/scheduled-versions");
    await replica.bumpScheduledMessages("org_a", "conv_1");
    const res = await get("conv_1", etag);
    expect(res.status).toBe(200);
  });

  it("sem Redis disponível: sem ETag (nunca 304 com versão só local)", async () => {
    const etag = (await get("conv_1")).headers.get("etag")!;
    h.redis.down = true;
    const res = await get("conv_1", etag);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
  });
});
