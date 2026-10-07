/**
 * GET /api/sse/messages — comportamento por conexão, sem DB/Redis.
 *
 * RT-1: erro no filtro de visibilidade descarta o evento e mantém o stream;
 *       só falha no `controller.enqueue` fecha a conexão.
 * RT-2: `loadAuthzContext` uma vez por conexão dentro do TTL; sem escopo de
 *       funil o gate é pulado sem consultar nada.
 * RT-3: payload intacto reaproveita o frame pré-serializado do bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SseEventEnvelope } from "@/lib/sse-bus";

type Listener = (event: string, envelope: SseEventEnvelope) => void;

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  loadAuthzContext: vi.fn(),
  conversationBlockedByFunnel: vi.fn(),
  canViewPipeline: vi.fn(),
  buildInboxSseCardGate: vi.fn(),
  buildDealSseGate: vi.fn(),
  stripHiddenInboxSseCard: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  logWarn: vi.fn(),
  listeners: [] as Listener[],
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/authz", () => ({
  loadAuthzContext: mocks.loadAuthzContext,
  canViewPipeline: mocks.canViewPipeline,
  canViewStage: () => true,
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

vi.mock("@/lib/authz/funnel-visibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz/funnel-visibility")>();
  return {
    ...actual,
    conversationBlockedByFunnel: mocks.conversationBlockedByFunnel,
  };
});

vi.mock("@/lib/browser-api-cors-node", () => ({ applyBrowserApiCors: async () => undefined }));

vi.mock("@/lib/inbox-sse-card-visibility", () => ({
  allowAllInboxSseCards: () => true,
  allowAllDealSseGate: () => true,
  denyAllDealSseGate: () => false,
  buildDealSseGate: mocks.buildDealSseGate,
  buildInboxSseCardGate: mocks.buildInboxSseCardGate,
  stripHiddenInboxSseCard: mocks.stripHiddenInboxSseCard,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: mocks.logWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
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

// Teto de conexões (SSE-2) tem teste próprio em `route.limit.test.ts`.
vi.mock("@/lib/sse-connection-limit", () => ({
  SSE_EVICTED_EVENT: "sse_connection_evicted",
  SSE_HEARTBEAT_MS: 25_000,
  acquireSseConnection: async () => ({
    ok: true,
    slot: { connId: "c", heartbeat: async () => undefined, release: async () => undefined },
  }),
}));

import { GET } from "@/app/api/sse/messages/route";
import { __resetApiShutdownStateForTest, createApiShutdown } from "@/lib/api-shutdown";

const ORG = "org1";
const USER = "u1";

function adminCtx() {
  return {
    userId: USER,
    organizationId: ORG,
    isSuperAdmin: false,
    isAdmin: true,
    permissions: new Set<string>(),
    stageView: null,
    stageDeny: new Set<string>(),
    pipelineDeny: new Set<string>(),
  };
}

function restrictedCtx(denyPipelineIds: string[]) {
  return { ...adminCtx(), isAdmin: false, pipelineDeny: new Set(denyPipelineIds) };
}

function envelope(data: Record<string, unknown>, event = "conversation_updated") {
  const wire = new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  return { organizationId: ORG, data, wire } satisfies SseEventEnvelope;
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
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
  expect(mocks.listeners).toHaveLength(1);
  return { reader, next, emit: mocks.listeners[0] };
}

describe("GET /api/sse/messages — filtro, memo de authz e frame", () => {
  let now = 1_700_000_000_000;
  let openReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.length = 0;
    now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.auth.mockResolvedValue({
      user: { id: USER, role: "MEMBER", organizationId: ORG, isSuperAdmin: false },
    });
    mocks.buildInboxSseCardGate.mockResolvedValue(() => true);
    mocks.buildDealSseGate.mockResolvedValue(() => true);
    mocks.stripHiddenInboxSseCard.mockImplementation((data: unknown) => data);
    mocks.loadAuthzContext.mockResolvedValue(adminCtx());
    mocks.conversationBlockedByFunnel.mockResolvedValue(false);
    mocks.canViewPipeline.mockImplementation(
      (ctx: { pipelineDeny: Set<string> }, id: string) => !ctx.pipelineDeny.has(id),
    );
    mocks.subscribe.mockImplementation((_ctx: unknown, fn: Listener) => {
      mocks.listeners.push(fn);
      return mocks.unsubscribe;
    });
  });

  afterEach(async () => {
    await openReader?.cancel().catch(() => undefined);
    openReader = null;
    vi.restoreAllMocks();
  });

  it("RT-1: erro no filtro descarta o evento, loga e NÃO fecha o stream", async () => {
    mocks.loadAuthzContext.mockRejectedValueOnce(new Error("pool esgotado"));
    const { reader, next, emit } = await open();
    openReader = reader;

    emit("conversation_updated", envelope({ conversationId: "c1", pipelineId: "p1" }));
    await flush();
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatch(/descartado/);

    // O stream segue vivo: o próximo evento chega.
    emit("conversation_updated", envelope({ conversationId: "c2" }));
    expect(await next()).toContain('"conversationId":"c2"');
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it("RT-1: erro no gate de card também é descartado sem fechar", async () => {
    mocks.stripHiddenInboxSseCard.mockImplementationOnce(() => {
      throw new Error("gate quebrou");
    });
    const { reader, next, emit } = await open();
    openReader = reader;

    emit("new_message", envelope({ conversationId: "c1" }, "new_message"));
    await flush();
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);

    emit("new_message", envelope({ conversationId: "c2" }, "new_message"));
    expect(await next()).toContain("event: new_message");
  });

  it("RT-1: falha no enqueue (stream fechado) encerra a conexão", async () => {
    const { reader, next, emit } = await open();
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
    enqueue.mockImplementationOnce(() => {
      throw new TypeError("Invalid state: Controller is already closed");
    });

    emit("conversation_updated", envelope({ conversationId: "c1" }));
    await flush();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(await next()).toBeNull();
    await reader.cancel().catch(() => undefined);
  });

  it("RT-2: sem escopo de funil o ctx carrega uma vez e o gate é pulado", async () => {
    const { reader, next, emit } = await open();
    openReader = reader;

    for (const id of ["c1", "c2", "c3"]) {
      emit("conversation_updated", envelope({ conversationId: id, pipelineId: "p1" }));
      expect(await next()).toContain(`"conversationId":"${id}"`);
    }
    expect(mocks.loadAuthzContext).toHaveBeenCalledTimes(1);
    expect(mocks.canViewPipeline).not.toHaveBeenCalled();
    expect(mocks.conversationBlockedByFunnel).not.toHaveBeenCalled();
  });

  it("RT-2: eventos concorrentes compartilham a mesma carga (singleflight)", async () => {
    const { reader, next, emit } = await open();
    openReader = reader;

    emit("conversation_updated", envelope({ conversationId: "c1" }));
    emit("conversation_updated", envelope({ conversationId: "c2" }));
    expect(await next()).toContain("c1");
    expect(await next()).toContain("c2");
    expect(mocks.loadAuthzContext).toHaveBeenCalledTimes(1);
  });

  it("RT-2: com escopo de funil, bloqueia pipeline negado e recarrega após o TTL", async () => {
    mocks.loadAuthzContext.mockResolvedValue(restrictedCtx(["p_denied"]));
    const { reader, next, emit } = await open();
    openReader = reader;

    emit("deal_moved", envelope({ pipelineId: "p_denied", dealId: "d1" }, "deal_moved"));
    await flush();
    emit("deal_moved", envelope({ pipelineId: "p_ok", dealId: "d2" }, "deal_moved"));
    const frame = await next();
    expect(frame).toContain('"dealId":"d2"');
    expect(frame).not.toContain("d1");
    expect(mocks.loadAuthzContext).toHaveBeenCalledTimes(1);

    // Dentro do TTL: sem nova carga.
    now += 30_000;
    emit("deal_moved", envelope({ pipelineId: "p_ok", dealId: "d3" }, "deal_moved"));
    expect(await next()).toContain("d3");
    expect(mocks.loadAuthzContext).toHaveBeenCalledTimes(1);

    // TTL vencido: recarrega (grants podem ter mudado).
    now += 20_000;
    mocks.loadAuthzContext.mockResolvedValue(adminCtx());
    emit("deal_moved", envelope({ pipelineId: "p_denied", dealId: "d4" }, "deal_moved"));
    expect(await next()).toContain("d4");
    expect(mocks.loadAuthzContext).toHaveBeenCalledTimes(2);
  });

  it("RT-3: payload intacto usa o frame do bus; alterado re-serializa", async () => {
    const { reader, next, emit } = await open();
    openReader = reader;

    const env = envelope({ conversationId: "c1", card: { assignedToId: "x" } });
    const stringify = vi.spyOn(JSON, "stringify");
    emit("conversation_updated", env);
    const same = await next();
    expect(same).toBe(new TextDecoder().decode(env.wire));
    expect(stringify.mock.calls.some((c) => c[0] === env.data)).toBe(false);

    mocks.stripHiddenInboxSseCard.mockImplementationOnce((data: unknown) => {
      const { card: _c, ...rest } = data as Record<string, unknown>;
      return { ...rest, cardOmitted: "hidden" };
    });
    const env2 = envelope({ conversationId: "c2", card: { assignedToId: "y" } });
    emit("conversation_updated", env2);
    const changed = await next();
    expect(changed).toContain('"cardOmitted":"hidden"');
    expect(changed).not.toContain("assignedToId");
  });

  it("deal_moved: quem não vê o destino recebe o evento sem card; quem não vê nenhum lado não recebe", async () => {
    mocks.loadAuthzContext.mockResolvedValue(restrictedCtx(["p_denied"]));
    const { reader, next, emit } = await open();
    openReader = reader;

    emit(
      "deal_moved",
      envelope(
        {
          organizationId: ORG,
          dealId: "d1",
          fromPipelineId: "p_ok",
          toPipelineId: "p_denied",
          fromStageId: "s_from",
          toStageId: "s_to",
          position: 1,
          updatedAt: "2026-10-05T12:00:00.000Z",
          card: { id: "d1", title: "SEGREDO" },
        },
        "deal_moved",
      ),
    );
    const originOnly = await next();
    expect(originOnly).toContain('"dealId":"d1"');
    expect(originOnly).toContain('"fromPipelineId":"p_ok"');
    expect(originOnly).not.toContain("SEGREDO");
    expect(originOnly).not.toContain('"card"');

    emit(
      "deal_moved",
      envelope(
        {
          organizationId: ORG,
          dealId: "d-hidden",
          fromPipelineId: "p_denied",
          toPipelineId: "p_denied",
          fromStageId: "s_a",
          toStageId: "s_b",
          position: 0,
          updatedAt: "2026-10-05T12:00:00.000Z",
          card: { id: "d-hidden", title: "OUTRO" },
        },
        "deal_moved",
      ),
    );
    await flush();
    emit(
      "deal_moved",
      envelope(
        {
          organizationId: ORG,
          dealId: "d2",
          fromPipelineId: "p_ok",
          toPipelineId: "p_ok",
          fromStageId: "s1",
          toStageId: "s2",
          position: 0,
          updatedAt: "2026-10-05T12:00:00.000Z",
        },
        "deal_moved",
      ),
    );
    const both = await next();
    expect(both).toContain('"dealId":"d2"');
    expect(both).not.toContain("d-hidden");
    expect(both).not.toContain("OUTRO");
  });

  describe("deal_moved por posse do negócio (dono)", () => {
    const dealMoved = (extra: Record<string, unknown>) =>
      envelope(
        {
          organizationId: ORG,
          fromPipelineId: "p_ok",
          toPipelineId: "p_ok",
          fromStageId: "s1",
          toStageId: "s2",
          position: 1,
          updatedAt: "2026-10-07T12:00:00.000Z",
          ...extra,
        },
        "deal_moved",
      );

    it("MEMBER 'só meus' NÃO recebe título/contato/valor de negócio de outro dono (só os ids)", async () => {
      mocks.loadAuthzContext.mockResolvedValue(restrictedCtx([]));
      mocks.buildDealSseGate.mockResolvedValue((d: { ownerId?: string | null }) => d.ownerId === USER);
      const { reader, next, emit } = await open();
      openReader = reader;

      emit(
        "deal_moved",
        dealMoved({
          dealId: "d-outro",
          ownerId: "u-outro",
          orgUnitId: "unit-1",
          card: { id: "d-outro", title: "SEGREDO", value: 9999, contact: { name: "CLIENTE ALHEIO" } },
        }),
      );
      const other = await next();
      expect(other).toContain('"dealId":"d-outro"');
      expect(other).toContain('"toStageId":"s2"');
      expect(other).not.toContain("SEGREDO");
      expect(other).not.toContain("CLIENTE ALHEIO");
      expect(other).not.toContain("9999");
      expect(other).not.toContain('"card"');
      expect(other).not.toContain("ownerId");
      expect(other).not.toContain("unit-1");

      emit(
        "deal_moved",
        dealMoved({
          dealId: "d-meu",
          ownerId: USER,
          orgUnitId: "unit-1",
          card: { id: "d-meu", title: "MEU NEGOCIO", value: 50 },
        }),
      );
      const own = await next();
      expect(own).toContain("MEU NEGOCIO");
      expect(own).toContain(`"ownerId":"${USER}"`);
    });

    it("payload sem ownerId (publisher antigo): quem só vê os próprios fica sem card", async () => {
      mocks.loadAuthzContext.mockResolvedValue(restrictedCtx([]));
      mocks.buildDealSseGate.mockResolvedValue((d: { ownerId?: string | null }) => d.ownerId === USER);
      const { reader, next, emit } = await open();
      openReader = reader;

      emit("deal_moved", dealMoved({ dealId: "d-legado", card: { id: "d-legado", title: "SEGREDO" } }));
      const frame = await next();
      expect(frame).toContain('"dealId":"d-legado"');
      expect(frame).not.toContain("SEGREDO");
    });

    it("admin recebe o card de qualquer dono, sem montar o gate de posse", async () => {
      mocks.loadAuthzContext.mockResolvedValue(adminCtx());
      const { reader, next, emit } = await open();
      openReader = reader;

      emit(
        "deal_moved",
        dealMoved({ dealId: "d1", ownerId: "u-outro", card: { id: "d1", title: "VISIVEL" } }),
      );
      expect(await next()).toContain("VISIVEL");
      expect(mocks.buildDealSseGate).not.toHaveBeenCalled();
    });

    it("gate de posse que falha nega o card (evento sai só com ids) e remonta no próximo evento", async () => {
      mocks.loadAuthzContext.mockResolvedValue(restrictedCtx([]));
      mocks.buildDealSseGate
        .mockRejectedValueOnce(new Error("pool cheio"))
        .mockResolvedValue((d: { ownerId?: string | null }) => d.ownerId === USER);
      const { reader, next, emit } = await open();
      openReader = reader;

      emit("deal_moved", dealMoved({ dealId: "d1", ownerId: USER, card: { id: "d1", title: "MEU" } }));
      const first = await next();
      expect(first).toContain('"dealId":"d1"');
      expect(first).not.toContain('"card"');
      expect(mocks.logWarn).toHaveBeenCalled();

      emit("deal_moved", dealMoved({ dealId: "d2", ownerId: USER, card: { id: "d2", title: "MEU" } }));
      expect(await next()).toContain('"title":"MEU"');
      expect(mocks.buildDealSseGate).toHaveBeenCalledTimes(2);
    });
  });

  it("sse_access_revoked fecha a conexão", async () => {
    const { reader, next, emit } = await open();
    emit("sse_access_revoked", envelope({ userId: USER }, "sse_access_revoked"));
    await flush();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(await next()).toBeNull();
    await reader.cancel().catch(() => undefined);
  });
});

describe("GET /api/sse/messages — parada graciosa e gate fail-closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.length = 0;
    __resetApiShutdownStateForTest();
    mocks.auth.mockResolvedValue({
      user: { id: USER, role: "MEMBER", organizationId: ORG, isSuperAdmin: false },
    });
    mocks.buildInboxSseCardGate.mockResolvedValue(() => true);
    mocks.stripHiddenInboxSseCard.mockImplementation((data: unknown) => data);
    mocks.loadAuthzContext.mockResolvedValue(adminCtx());
    mocks.subscribe.mockImplementation((_ctx: unknown, fn: Listener) => {
      mocks.listeners.push(fn);
      return mocks.unsubscribe;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetApiShutdownStateForTest();
  });

  it("V-INF-2: gate que falha nega todo card e é remontado depois", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    mocks.buildInboxSseCardGate
      .mockRejectedValueOnce(new Error("pool esgotado"))
      .mockResolvedValueOnce(() => true);
    const { reader, next, emit } = await open();

    emit("new_message", envelope({ conversationId: "c1", card: {} }, "new_message"));
    expect(await next()).toContain("event: new_message");
    const failClosedGate = mocks.stripHiddenInboxSseCard.mock.calls[0][1] as (c: object) => boolean;
    expect(failClosedGate({ assignedToId: USER })).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.buildInboxSseCardGate).toHaveBeenCalledTimes(2);

    // Os 30 s avançados também dispararam um heartbeat (25 s).
    expect(await next()).toBe(": heartbeat\n\nevent: heartbeat\ndata: {}\n\n");
    emit("new_message", envelope({ conversationId: "c2", card: {} }, "new_message"));
    expect(await next()).toContain('"conversationId":"c2"');
    const remounted = mocks.stripHiddenInboxSseCard.mock.calls[1][1] as (c: object) => boolean;
    expect(remounted({})).toBe(true);
    await reader.cancel().catch(() => undefined);
  });

  it("SIGTERM: stream aberto recebe retry com jitter e fecha; conexão nova leva 503", async () => {
    const { next } = await open();
    const exit = vi.fn();
    await createApiShutdown({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      preStopMs: 0,
      getServers: () => [],
      exit,
      random: () => 0,
    })("SIGTERM");

    const frame = await next();
    expect(frame).toMatch(/^retry: 2000\nevent: sse_connection_evicted\n/);
    expect(frame).toContain('"reason":"server_shutdown"');
    expect(await next()).toBeNull();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    const res = await GET(new Request("https://api.test/api/sse/messages"));
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(2);
    expect(mocks.auth).toHaveBeenCalledTimes(1); // recusada antes da sessão
  });
});
