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

vi.mock("@/lib/browser-api-cors", () => ({ applyBrowserApiCors: () => undefined }));

vi.mock("@/lib/inbox-sse-card-visibility", () => ({
  allowAllInboxSseCards: () => true,
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

import { GET } from "@/app/api/sse/messages/route";

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

  it("sse_access_revoked fecha a conexão", async () => {
    const { reader, next, emit } = await open();
    emit("sse_access_revoked", envelope({ userId: USER }, "sse_access_revoked"));
    await flush();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(await next()).toBeNull();
    await reader.cancel().catch(() => undefined);
  });
});
