/**
 * POST /typing (M-BE-1):
 * - publica o evento SSE `typing` para os outros agentes mesmo quando o
 *   canal Meta não repassa o indicador (sem config / sem recibo de leitura);
 * - acesso em cache por 60 s: no acerto, ZERO consultas ao Postgres;
 * - a chamada à Graph não é aguardada pela resposta, tem 1 tentativa e sai
 *   no máximo 1 vez por conversa a cada 20 s (claim no Redis, entre réplicas);
 * - nenhuma escrita no banco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    publish: vi.fn(),
    pgCalls: [] as string[],
    conversation: {
      id: "conv_1",
      assignedToId: "user_a",
      channelId: "ch_1",
      contactId: "contact_1",
      organizationId: "org_1",
      channelRef: { config: { metaOn: true } as Record<string, unknown> },
    } as Record<string, unknown> | null,
    channelConfig: { metaOn: true } as Record<string, unknown>,
    lastInbound: { externalId: "wamid.IN1" } as { externalId: string } | null,
    metaConfigured: true,
    readReceipts: true,
    sendTypingIndicator: vi.fn(),
    accessDenied: false,
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: vi.fn(async (handler: (session: unknown) => unknown) =>
    handler({
      user: { id: "user_a", name: "Ana", organizationId: "org_1", role: "MEMBER" },
    }),
  ),
}));

/** Todo acesso ao Prisma passa por aqui e fica registrado (`model.op`). */
function pg<T>(label: string, result: () => T) {
  return vi.fn(async () => {
    h.pgCalls.push(label);
    return result();
  });
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findFirst: pg("conversation.findFirst", () => h.conversation),
      update: pg("conversation.update", () => null),
      updateMany: pg("conversation.updateMany", () => null),
    },
    channel: {
      findUnique: pg("channel.findUnique", () => ({ config: h.channelConfig })),
    },
    message: {
      findFirst: pg("message.findFirst", () => h.lastInbound),
      update: pg("message.update", () => null),
      updateMany: pg("message.updateMany", () => null),
    },
  },
}));

// Checagem de acesso: carrega a linha pelo `load` do handler (1 consulta,
// a mesma do caminho real) e decide pelo `h.accessDenied`.
vi.mock("@/lib/conversation-access", async () => {
  const { NextResponse } = await import("next/server");
  return {
    CONVERSATION_ACCESS_SELECT: {
      id: true,
      assignedToId: true,
      channelId: true,
      contactId: true,
      organizationId: true,
    },
    requireConversationAccessAndLoad: vi.fn(
      async (_s: unknown, id: string, load: (w: unknown) => Promise<unknown>) => {
        const row = await load({ id });
        if (!row || h.accessDenied) {
          return {
            response: NextResponse.json(
              { message: "Conversa não encontrada ou sem permissão." },
              { status: 404 },
            ),
          };
        }
        return { conversation: row };
      },
    ),
  };
});
vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: (config: Record<string, unknown> | null | undefined) => ({
    configured: Boolean(config?.metaOn) && h.metaConfigured,
    sendTypingIndicator: h.sendTypingIndicator,
  }),
}));
vi.mock("@/lib/channels/config", () => ({
  channelSendsReadReceipts: () => h.readReceipts,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: h.publish } }));

import { POST } from "@/app/api/conversations/[id]/typing/route";
import { __resetTypingThrottleForTests } from "@/lib/realtime-events";
import { fakeRedisRaw } from "@/test-setup/fake-cache-redis";

function call(id = "conv_1") {
  return POST(new Request("http://localhost/api/conversations/x/typing", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

/** Deixa o despacho em segundo plano (sem await na rota) terminar. */
async function flushBackground() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("POST /api/conversations/:id/typing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-30T12:00:00.000Z"));
    h.redis.store.clear();
    h.redis.calls.length = 0;
    h.redis.down = false;
    h.publish.mockReset();
    h.pgCalls.length = 0;
    h.sendTypingIndicator.mockReset();
    h.sendTypingIndicator.mockResolvedValue(undefined);
    h.metaConfigured = true;
    h.readReceipts = true;
    h.accessDenied = false;
    h.lastInbound = { externalId: "wamid.IN1" };
    __resetTypingThrottleForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publica `typing` com conversationId/contactId/userId/until mesmo sem Meta", async () => {
    h.metaConfigured = false;
    const res = await call();
    expect(await res.json()).toEqual({ ok: false });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith("typing", {
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: "user_a",
      userName: "Ana",
      source: "agent",
      until: "2026-09-30T12:00:05.000Z",
    });
    await flushBackground();
    expect(h.sendTypingIndicator).not.toHaveBeenCalled();
  });

  it("duas chamadas em 3s publicam uma vez; depois de 3s publica de novo", async () => {
    await call();
    vi.advanceTimersByTime(2_000);
    await call();
    expect(h.publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await call();
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("conversa inexistente ou sem acesso: 404, nada publicado e nada guardado", async () => {
    h.accessDenied = true;
    const res = await call("conv_404");
    expect(res.status).toBe(404);
    expect(h.publish).not.toHaveBeenCalled();
    expect(fakeRedisRaw(h.redis, "cache:typing_acl:org_1:user_a:conv_404")).toBeNull();
    // Negado não fica em cache: a próxima batida consulta de novo.
    h.pgCalls.length = 0;
    await call("conv_404");
    expect(h.pgCalls).toEqual(["conversation.findFirst"]);
  });

  it("acesso em cache: a 2ª batida não consulta o Postgres; 60 s depois consulta de novo", async () => {
    await call();
    expect(h.pgCalls.filter((c) => c.startsWith("conversation."))).toEqual([
      "conversation.findFirst",
    ]);
    await flushBackground();

    h.pgCalls.length = 0;
    vi.advanceTimersByTime(3_000);
    const res = await call();
    expect(res.status).toBe(200);
    // Hot path no acerto: zero consultas (o despacho da Graph está na janela
    // de 20 s e também não consulta).
    await flushBackground();
    expect(h.pgCalls).toEqual([]);
    expect(h.publish).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    h.pgCalls.length = 0;
    await call();
    expect(h.pgCalls).toContain("conversation.findFirst");
  });

  it("a resposta não espera a Graph (que nunca responde)", async () => {
    h.sendTypingIndicator.mockReturnValue(new Promise(() => {}));
    const res = await call();
    expect(await res.json()).toEqual({ ok: true });
    await flushBackground();
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1);
    expect(h.sendTypingIndicator).toHaveBeenCalledWith("wamid.IN1", {
      maxAttempts: 1,
      timeoutMs: 5_000,
    });
  });

  it("falha da Graph não vira erro na resposta", async () => {
    h.sendTypingIndicator.mockRejectedValue(new Error("graph down"));
    const res = await call();
    expect(await res.json()).toEqual({ ok: true });
    await flushBackground();
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1);
  });

  it("dedupe: 1 chamada à Graph por conversa a cada 20 s, entre agentes", async () => {
    await call();
    await flushBackground();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(3_000);
      await call();
      await flushBackground();
    }
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1);
    expect(
      fakeRedisRaw(h.redis, "cache:typing_meta:org_1:conv_1"),
    ).not.toBeNull();

    vi.advanceTimersByTime(5_001); // 20 s desde a 1ª
    await call();
    await flushBackground();
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(2);
  });

  it("recibo de leitura desligado: sem Graph (não vaza o visto azul)", async () => {
    h.readReceipts = false;
    const res = await call();
    expect(await res.json()).toEqual({ ok: false });
    await flushBackground();
    expect(h.sendTypingIndicator).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("sem inbound com wamid: não chama a Graph", async () => {
    h.lastInbound = null;
    await call();
    await flushBackground();
    expect(h.sendTypingIndicator).not.toHaveBeenCalled();
  });

  it("nenhuma escrita no banco", async () => {
    await call();
    await flushBackground();
    vi.advanceTimersByTime(25_000);
    await call();
    await flushBackground();
    expect(
      h.pgCalls.filter((c) => /\.(update|updateMany|create|upsert|delete)/.test(c)),
    ).toEqual([]);
  });

  it("Redis fora: acesso e dedupe caem no Map do processo", async () => {
    h.redis.down = true;
    await call();
    await flushBackground();
    h.pgCalls.length = 0;
    vi.advanceTimersByTime(3_000);
    await call();
    await flushBackground();
    expect(h.pgCalls).toEqual([]);
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1);
  });
});
