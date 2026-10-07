/**
 * `services/automation-context` — espera de resposta e sweeper de timeout
 * sem Postgres/Redis (CL-15). Timers falsos.
 *
 * Cobre:
 *  - `pauseContext` (PAUSED + SSE `automation_state` com organizationId).
 *  - `processIncomingMessage` em `wait_for_reply`: retoma pelo
 *    `receivedGotoStepId` salvando a resposta na variável; ao cair num
 *    passo pausante arma `timeoutAt` (TTL de segurança ou `timeoutMs` do
 *    autor); handoff (IA atendendo, consultor falou depois da pausa, passo
 *    que não espera resposta) cancela; envio in-flight não é consumido.
 *  - `processTimeout` / `sweepExpiredTimeouts`: só contextos RUNNING com
 *    `timeoutAt <= agora`, cada um na org do próprio contexto; TTL sintético
 *    encerra sem seguir aresta; inbound novo aborta o timeout.
 *  - `startTimeoutSweeper` / `stopTimeoutSweeper`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    ctx: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([] as unknown[]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    step: { findUnique: vi.fn() },
    message: {
      findFirst: vi.fn().mockResolvedValue(null as { createdAt: Date } | null),
      findMany: vi.fn().mockResolvedValue([] as unknown[]),
    },
    conversation: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([] as unknown[]),
    },
    baseCtxFindMany: vi.fn().mockResolvedValue([] as unknown[]),
    ssePublish: vi.fn(),
    attendance: vi.fn(),
    continueFromStep: vi.fn().mockResolvedValue(undefined),
    updateOrgSeen: [] as Array<{ id: string; org: string | null }>,
  };
});

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

// O log saiu do `console` e foi para o logger estruturado: o teste espiona
// o logger e mantém a mesma garantia (o erro de um contexto é logado).
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationContext: h.ctx,
    automationStep: h.step,
    message: h.message,
    conversation: h.conversation,
  },
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { automationContext: { findMany: h.baseCtxFindMany } },
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: h.ssePublish } }));
vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForContact: h.attendance,
}));
vi.mock("@/services/automation-executor", () => ({
  continueFromStep: h.continueFromStep,
}));
vi.mock("@/lib/ai-agents/tabulation-classify-policy", () => ({
  messageHasMedia: (msg: { messageType?: string | null } | null | undefined) => {
    const type = (msg?.messageType ?? "").toLowerCase();
    return type === "image" || type === "document" || type === "audio" || type === "video" || type === "sticker";
  },
  isIdleClosingText: () => false,
}));

import { getOrgIdOrNull, runWithContext } from "@/lib/request-context";
import {
  isInFlightPlainSend,
  markPausedTtl,
  PAUSED_CONTEXT_TTL_MS,
  pauseContext,
  pausedStepTimeoutMs,
  processIncomingMessage,
  processTimeout,
  startTimeoutSweeper,
  stopTimeoutSweeper,
  sweepExpiredTimeouts,
  waitForReplyHijacksAiTurn,
} from "@/services/automation-context";

const ORG = "org-a";
const NOW = new Date("2026-09-30T12:00:00Z");
const PAUSED_AT = new Date("2026-09-30T11:00:00Z");

type Step = { id: string; type: string; position: number; config: Record<string, unknown> };

const STEPS: Step[] = [
  { id: "step-send", type: "send_whatsapp_message", position: 0, config: {} },
  {
    id: "step-wait",
    type: "wait_for_reply",
    position: 1,
    config: {
      saveToVariable: "resposta",
      receivedGotoStepId: "step-next",
      timeoutGotoStepId: "step-timeout",
    },
  },
  { id: "step-next", type: "move_stage", position: 2, config: {} },
  { id: "step-timeout", type: "send_whatsapp_message", position: 3, config: {} },
  { id: "step-q", type: "question", position: 4, config: { timeoutMs: 60_000 } },
  { id: "step-delay", type: "delay", position: 5, config: {} },
  { id: "step-finish", type: "finish", position: 6, config: {} },
];

function withSteps(patch: Partial<Record<string, Partial<Step>>>): Step[] {
  return STEPS.map((s) => (patch[s.id] ? { ...s, ...patch[s.id], config: { ...s.config, ...(patch[s.id]!.config ?? {}) } } : s));
}

function ctxRow(over: Record<string, unknown> = {}, steps: Step[] = STEPS) {
  return {
    id: "ctx-1",
    organizationId: ORG,
    automationId: "auto-1",
    contactId: "contact-1",
    currentStepId: "step-wait",
    status: "RUNNING",
    timeoutAt: new Date(NOW.getTime() + 3_600_000),
    variables: { conversationId: "conv-1" },
    createdAt: PAUSED_AT,
    updatedAt: PAUSED_AT,
    automation: { id: "auto-1", name: "Fluxo", steps },
    ...over,
  };
}

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

function updateData(callIndex = 0): Record<string, unknown> {
  return (h.ctx.update.mock.calls[callIndex]![0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW });
  h.updateOrgSeen.length = 0;
  h.ctx.findMany.mockResolvedValue([]);
  h.ctx.update.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      h.updateOrgSeen.push({ id: args.where.id, org: getOrgIdOrNull() });
      return { ...ctxRow(), id: args.where.id, ...args.data };
    },
  );
  h.ctx.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === "ctx-1" ? { id: "ctx-1", status: "RUNNING" } : null,
  );
  h.attendance.mockResolvedValue({
    assignedToId: null,
    assigneeType: null,
    humanAttending: false,
    hasHumanReply: false,
  });
  h.message.findFirst.mockResolvedValue(null);
  h.message.findMany.mockResolvedValue([]);
  h.conversation.findFirst.mockResolvedValue({
    status: "OPEN",
    lastInboundAt: null,
    assignedToId: null,
    assignedTo: null,
    closedAt: null,
  });
  h.conversation.findMany.mockResolvedValue([]);
  h.baseCtxFindMany.mockResolvedValue([]);
});

afterEach(() => {
  stopTimeoutSweeper();
  vi.useRealTimers();
});

describe("pauseContext", () => {
  it("marca PAUSED e avisa o inbox (automation_state) com a org do contexto", async () => {
    const row = await withOrg(ORG, () => pauseContext("ctx-1"));
    expect(h.ctx.update).toHaveBeenCalledWith({ where: { id: "ctx-1" }, data: { status: "PAUSED" } });
    expect(row.status).toBe("PAUSED");
    expect(h.ssePublish).toHaveBeenCalledWith(
      "automation_state",
      expect.objectContaining({
        organizationId: ORG,
        contactId: "contact-1",
        automationId: "auto-1",
        status: "PAUSED",
        active: true,
      }),
    );
  });
});

describe("processIncomingMessage — wait_for_reply", () => {
  it("resposta do cliente retoma pelo receivedGotoStepId, salva a variável e continua a execução", async () => {
    h.ctx.findMany.mockResolvedValueOnce([ctxRow()]);

    const out = await withOrg(ORG, () =>
      processIncomingMessage("contact-1", "sim, quero", { conversationId: "conv-1" }),
    );

    expect(out).toEqual({ handled: true, replied: true, automationId: "auto-1", contextId: "ctx-1" });
    expect(h.ctx.update).toHaveBeenCalledTimes(1);
    expect(h.ctx.update.mock.calls[0]![0]).toEqual({
      where: { id: "ctx-1" },
      data: {
        currentStepId: "step-next",
        variables: { conversationId: "conv-1", resposta: "sim, quero" },
        timeoutAt: null,
      },
    });
    expect(h.continueFromStep).toHaveBeenCalledWith("auto-1", "contact-1", "step-next", {
      conversationId: "conv-1",
      resposta: "sim, quero",
    });
    expect(h.ssePublish).toHaveBeenCalledWith(
      "automation_state",
      expect.objectContaining({ organizationId: ORG, status: "RUNNING", active: true }),
    );
  });

  it("ao cair num passo pausante SEM timeout do autor arma o TTL de segurança e marca a variável", async () => {
    h.ctx.findMany.mockResolvedValueOnce([
      ctxRow({}, withSteps({ "step-wait": { config: { receivedGotoStepId: "step-timeout" } } })),
    ]);

    await withOrg(ORG, () => processIncomingMessage("contact-1", "ok"));

    const data = updateData();
    expect(data.currentStepId).toBe("step-timeout");
    expect(data.timeoutAt).toEqual(new Date(NOW.getTime() + PAUSED_CONTEXT_TTL_MS));
    expect(data.variables).toMatchObject({ __pausedTtlStepId: "step-timeout", resposta: "ok" });
    // o executor recebe as variáveis SEM o marcador interno
    expect(h.continueFromStep.mock.calls[0]![3]).not.toHaveProperty("__pausedTtlStepId");
  });

  it("passo pausante COM timeoutMs do autor usa o timeout dele, sem marcador de TTL", async () => {
    h.ctx.findMany.mockResolvedValueOnce([
      ctxRow(
        { variables: { conversationId: "conv-1", __pausedTtlStepId: "step-wait" } },
        withSteps({ "step-wait": { config: { receivedGotoStepId: "step-q" } } }),
      ),
    ]);

    await withOrg(ORG, () => processIncomingMessage("contact-1", "ok"));

    const data = updateData();
    expect(data.currentStepId).toBe("step-q");
    expect(data.timeoutAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(data.variables).not.toHaveProperty("__pausedTtlStepId");
  });

  it("wait_for_reply encadeado: a mesma resposta atravessa a cascata até um passo que executa", async () => {
    const steps = withSteps({
      "step-wait": { config: { receivedGotoStepId: "step-wait-2" } },
    });
    steps.push({
      id: "step-wait-2",
      type: "wait_for_reply",
      position: 7,
      config: { receivedGotoStepId: "step-next" },
    });
    h.ctx.findMany.mockResolvedValueOnce([ctxRow({}, steps)]);

    await withOrg(ORG, () => processIncomingMessage("contact-1", "ok"));
    expect(updateData().currentStepId).toBe("step-next");
    expect(h.continueFromStep).toHaveBeenCalledWith("auto-1", "contact-1", "step-next", expect.anything());
  });

  it("resposta recebida leva a `finish` → contexto COMPLETED sem executar nada", async () => {
    h.ctx.findMany.mockResolvedValueOnce([
      ctxRow({}, withSteps({ "step-wait": { config: { receivedGotoStepId: "step-finish" } } })),
    ]);
    const out = await withOrg(ORG, () => processIncomingMessage("contact-1", "ok"));
    expect(out.handled).toBe(true);
    expect(updateData()).toMatchObject({ status: "COMPLETED", currentStepId: null, timeoutAt: null });
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("IA atendendo + texto livre: não rouba o turno do agente — cancela o contexto (handoff)", async () => {
    h.attendance.mockResolvedValue({
      assignedToId: "ai-1",
      assigneeType: "AI",
      humanAttending: false,
      hasHumanReply: false,
    });
    h.ctx.findMany.mockResolvedValueOnce([ctxRow()]);

    const out = await withOrg(ORG, () => processIncomingMessage("contact-1", "qual o valor?"));

    expect(out).toEqual({ handled: false, replied: false });
    expect(updateData()).toEqual({ status: "COMPLETED", currentStepId: null, timeoutAt: null });
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("IA atendendo + clique de botão: retoma o fluxo (o cliente respondeu ao robô de propósito)", async () => {
    h.attendance.mockResolvedValue({
      assignedToId: "ai-1",
      assigneeType: "AI",
      humanAttending: false,
      hasHumanReply: false,
    });
    h.ctx.findMany.mockResolvedValueOnce([ctxRow()]);

    const out = await withOrg(ORG, () =>
      processIncomingMessage("contact-1", "Sim", { interactiveId: "btn_0" }),
    );
    expect(out.handled).toBe(true);
    expect(updateData().currentStepId).toBe("step-next");
  });

  it("consultor falou DEPOIS da pausa cancela; reply humano anterior (flag sticky) não cancela", async () => {
    h.attendance.mockResolvedValue({
      assignedToId: "u-1",
      assigneeType: "HUMAN",
      humanAttending: true,
      hasHumanReply: true,
    });

    h.message.findFirst.mockResolvedValueOnce({ createdAt: new Date(PAUSED_AT.getTime() + 60_000) });
    h.ctx.findMany.mockResolvedValueOnce([ctxRow()]);
    const cancelled = await withOrg(ORG, () => processIncomingMessage("contact-1", "oi"));
    expect(cancelled.handled).toBe(false);
    expect(updateData()).toMatchObject({ status: "COMPLETED" });
    expect(h.continueFromStep).not.toHaveBeenCalled();

    vi.clearAllMocks();
    h.message.findFirst.mockResolvedValueOnce({ createdAt: new Date(PAUSED_AT.getTime() - 60_000) });
    h.ctx.findMany.mockResolvedValueOnce([ctxRow()]);
    const resumed = await withOrg(ORG, () => processIncomingMessage("contact-1", "oi"));
    expect(resumed.handled).toBe(true);
    expect(updateData().currentStepId).toBe("step-next");
  });

  it("texto puro in-flight (sem timeoutAt) não é consumido nem cancelado", async () => {
    h.ctx.findMany.mockResolvedValueOnce([ctxRow({ currentStepId: "step-send", timeoutAt: null })]);
    const out = await withOrg(ORG, () => processIncomingMessage("contact-1", "oi"));
    expect(out).toEqual({ handled: false, replied: false });
    expect(h.ctx.update).not.toHaveBeenCalled();
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("passo que não espera resposta (delay) ou ponteiro morto: cancela para o card sair de Automação", async () => {
    h.ctx.findMany.mockResolvedValueOnce([ctxRow({ currentStepId: "step-delay" })]);
    expect((await withOrg(ORG, () => processIncomingMessage("contact-1", "oi"))).handled).toBe(false);
    expect(updateData()).toEqual({ status: "COMPLETED", currentStepId: null, timeoutAt: null });

    vi.clearAllMocks();
    h.ctx.findMany.mockResolvedValueOnce([ctxRow({ currentStepId: null })]);
    expect((await withOrg(ORG, () => processIncomingMessage("contact-1", "oi"))).handled).toBe(false);
    expect(updateData()).toMatchObject({ status: "COMPLETED" });
  });

  it("sem contexto ativo: nada a fazer", async () => {
    const out = await withOrg(ORG, () => processIncomingMessage("contact-1", "oi"));
    expect(out).toEqual({ handled: false, replied: false });
    expect(h.ctx.update).not.toHaveBeenCalled();
  });
});

describe("processTimeout / sweepExpiredTimeouts", () => {
  it("varre só RUNNING com timeoutAt vencido, processa cada contexto na org DELE e ignora os não-RUNNING", async () => {
    h.baseCtxFindMany.mockImplementation(async (args: { where: { timeoutAt: unknown } }) =>
      args.where.timeoutAt === null
        ? []
        : [
            { id: "ctx-1", organizationId: ORG },
            { id: "ctx-2", organizationId: "org-b" },
          ],
    );
    h.ctx.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === "ctx-1"
        ? ctxRow()
        : ctxRow({ id: "ctx-2", organizationId: "org-b", status: "PAUSED" }),
    );

    const n = await sweepExpiredTimeouts();

    expect(n).toBe(2);
    expect(h.baseCtxFindMany).toHaveBeenCalledTimes(2);
    expect(h.baseCtxFindMany.mock.calls[0]![0]).toEqual({
      where: { status: "RUNNING", timeoutAt: { not: null, lte: NOW } },
      select: { id: true, organizationId: true },
      take: 100,
    });
    // segunda varredura: RUNNING sem timer, parado há mais de 2 min
    expect(h.baseCtxFindMany.mock.calls[1]![0]).toMatchObject({
      where: { status: "RUNNING", timeoutAt: null, updatedAt: { lte: new Date(NOW.getTime() - 120_000) } },
    });

    // ctx-1 (vencido, RUNNING) seguiu a aresta de timeout dentro da org dele
    expect(h.updateOrgSeen).toEqual([{ id: "ctx-1", org: ORG }]);
    expect(updateData()).toMatchObject({
      currentStepId: "step-timeout",
      timeoutAt: new Date(NOW.getTime() + PAUSED_CONTEXT_TTL_MS),
      variables: { conversationId: "conv-1", __pausedTtlStepId: "step-timeout" },
    });
    expect(h.continueFromStep).toHaveBeenCalledWith("auto-1", "contact-1", "step-timeout", {
      conversationId: "conv-1",
    });
    // ctx-2 (PAUSED) não foi avançado
    expect(h.ctx.update.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id)).toEqual(["ctx-1"]);
  });

  it("um erro num contexto não impede os demais", async () => {
    h.baseCtxFindMany.mockImplementation(async (args: { where: { timeoutAt: unknown } }) =>
      args.where.timeoutAt === null
        ? []
        : [
            { id: "ctx-err", organizationId: ORG },
            { id: "ctx-1", organizationId: ORG },
          ],
    );
    h.ctx.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === "ctx-err") throw new Error("db down");
      return ctxRow();
    });
    logError.mockClear();

    const n = await sweepExpiredTimeouts();
    expect(n).toBe(1);
    expect(h.continueFromStep).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalled();
  });

  it("contextos RUNNING sem timer e parados há mais de 2 min são fechados (vazamento)", async () => {
    h.baseCtxFindMany.mockImplementation(async (args: { where: { timeoutAt: unknown } }) =>
      args.where.timeoutAt === null ? [{ id: "ctx-stale", organizationId: "org-s" }] : [],
    );
    const n = await sweepExpiredTimeouts();
    expect(n).toBe(1);
    expect(h.updateOrgSeen).toEqual([{ id: "ctx-stale", org: "org-s" }]);
    expect(updateData()).toEqual({ status: "COMPLETED", currentStepId: null, timeoutAt: null });
  });

  it("processTimeout ignora contexto inexistente / não-RUNNING / sem step", async () => {
    h.ctx.findUnique.mockResolvedValueOnce(null);
    await withOrg(ORG, () => processTimeout("nope"));
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow({ status: "COMPLETED" }));
    await withOrg(ORG, () => processTimeout("ctx-1"));
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow({ currentStepId: null }));
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(h.ctx.update).not.toHaveBeenCalled();
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("TTL sintético expirado só encerra o contexto — não segue aresta de timeout", async () => {
    h.ctx.findUnique.mockResolvedValueOnce(
      ctxRow({ variables: { conversationId: "conv-1", __pausedTtlStepId: "step-wait" } }),
    );
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(updateData()).toEqual({
      status: "COMPLETED",
      variables: { conversationId: "conv-1", __pausedTtlStepId: "step-wait" },
      currentStepId: null,
      timeoutAt: null,
    });
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("wait_for_reply sem timeoutGotoStepId fecha o contexto", async () => {
    h.ctx.findUnique.mockResolvedValueOnce(
      ctxRow({}, withSteps({ "step-wait": { config: { timeoutGotoStepId: null } } })),
    );
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(updateData()).toMatchObject({ status: "COMPLETED", currentStepId: null });
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("inbound novo depois da pausa aborta o timeout (não segue a aresta 'sem resposta')", async () => {
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow());
    h.conversation.findFirst.mockResolvedValueOnce({
      status: "OPEN",
      lastInboundAt: new Date(PAUSED_AT.getTime() + 5_000),
      assignedToId: null,
      assignedTo: null,
      closedAt: null,
    });
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(h.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "conv-1" } }),
    );
    expect(updateData()).toMatchObject({ status: "COMPLETED", currentStepId: null });
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("mídia ignorada pelo menu não aborta a aresta de timeout", async () => {
    const steps = withSteps({
      "step-wait": {
        type: "send_whatsapp_interactive",
        config: {
          buttons: [{ id: "btn_0", title: "CLT", gotoStepId: "step-next" }],
          timeoutGotoStepId: "step-timeout",
          onNonText: "stay",
        },
      },
    });
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow({ currentStepId: "step-wait" }, steps));
    h.conversation.findFirst.mockResolvedValueOnce({
      status: "OPEN",
      lastInboundAt: new Date(PAUSED_AT.getTime() + 5_000),
      assignedToId: null,
      assignedTo: null,
      closedAt: null,
    });
    h.message.findMany.mockResolvedValueOnce([
      { content: "curriculo.pdf", messageType: "document" },
    ]);
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(updateData().currentStepId).toBe("step-timeout");
    expect(h.continueFromStep).toHaveBeenCalledWith("auto-1", "contact-1", "step-timeout", {
      conversationId: "conv-1",
    });
  });

  it("texto livre depois da pausa ainda aborta o timeout do menu", async () => {
    const steps = withSteps({
      "step-wait": {
        type: "send_whatsapp_interactive",
        config: {
          buttons: [{ id: "btn_0", title: "CLT", gotoStepId: "step-next" }],
          timeoutGotoStepId: "step-timeout",
        },
      },
    });
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow({ currentStepId: "step-wait" }, steps));
    h.conversation.findFirst.mockResolvedValueOnce({
      status: "OPEN",
      lastInboundAt: new Date(PAUSED_AT.getTime() + 5_000),
      assignedToId: null,
      assignedTo: null,
      closedAt: null,
    });
    h.message.findMany.mockResolvedValueOnce([
      { content: "quero falar com alguém", messageType: "text" },
    ]);
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(updateData()).toMatchObject({ status: "COMPLETED", currentStepId: null });
    expect(h.continueFromStep).not.toHaveBeenCalled();
  });

  it("ticket encerrado DURANTE a espera aborta; encerrado ANTES da pausa (reativação) segue", async () => {
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow());
    h.conversation.findFirst.mockResolvedValueOnce({
      status: "RESOLVED",
      lastInboundAt: null,
      assignedToId: null,
      assignedTo: null,
      closedAt: new Date(PAUSED_AT.getTime() + 1_000),
    });
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(updateData()).toMatchObject({ status: "COMPLETED" });
    expect(h.continueFromStep).not.toHaveBeenCalled();

    vi.clearAllMocks();
    h.ctx.findUnique.mockResolvedValueOnce(ctxRow());
    h.conversation.findFirst.mockResolvedValueOnce({
      status: "RESOLVED",
      lastInboundAt: null,
      assignedToId: null,
      assignedTo: null,
      closedAt: new Date(PAUSED_AT.getTime() - 1_000),
    });
    await withOrg(ORG, () => processTimeout("ctx-1"));
    expect(updateData().currentStepId).toBe("step-timeout");
    expect(h.continueFromStep).toHaveBeenCalledTimes(1);
  });

  it("startTimeoutSweeper agenda varreduras periódicas (idempotente) e stop cancela", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    startTimeoutSweeper(1_000);
    startTimeoutSweeper(1_000);
    await vi.advanceTimersByTimeAsync(2_500);
    // cada varredura = 2 consultas (vencidos + vazados)
    expect(h.baseCtxFindMany).toHaveBeenCalledTimes(4);

    stopTimeoutSweeper();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.baseCtxFindMany).toHaveBeenCalledTimes(4);
    info.mockRestore();
  });
});

describe("helpers puros", () => {
  it("pausedStepTimeoutMs / markPausedTtl", () => {
    expect(pausedStepTimeoutMs(undefined)).toBe(PAUSED_CONTEXT_TTL_MS);
    expect(pausedStepTimeoutMs(0)).toBe(PAUSED_CONTEXT_TTL_MS);
    expect(pausedStepTimeoutMs(5_000)).toBe(5_000);
    expect(markPausedTtl({ a: 1 }, "s1", undefined)).toEqual({ a: 1, __pausedTtlStepId: "s1" });
    expect(markPausedTtl({ a: 1, __pausedTtlStepId: "s0" }, "s1", 5_000)).toEqual({ a: 1 });
  });

  it("waitForReplyHijacksAiTurn / isInFlightPlainSend", () => {
    expect(waitForReplyHijacksAiTurn({ stepType: "wait_for_reply", assigneeType: "AI" })).toBe(true);
    expect(waitForReplyHijacksAiTurn({ stepType: "wait_for_reply", assigneeType: "AI", interactiveId: "btn_0" })).toBe(false);
    expect(waitForReplyHijacksAiTurn({ stepType: "wait_for_reply", assigneeType: "HUMAN" })).toBe(false);
    expect(waitForReplyHijacksAiTurn({ stepType: "question", assigneeType: "AI" })).toBe(false);
    expect(isInFlightPlainSend({ stepType: "send_whatsapp_message", timeoutAt: null })).toBe(true);
    expect(isInFlightPlainSend({ stepType: "send_whatsapp_message", timeoutAt: NOW })).toBe(false);
    expect(isInFlightPlainSend({ stepType: "wait_for_reply", timeoutAt: null })).toBe(false);
  });
});
