/**
 * Fast-path do outbound humano: org/contato sem robô nem webhook
 * não paga cancelActiveContexts (include de steps) nem o corpo do fireTrigger.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueAutomation, dispatchIntegrationWebhooks, prismaMock } = vi.hoisted(() => ({
  enqueueAutomation: vi.fn(async () => undefined),
  dispatchIntegrationWebhooks: vi.fn(async () => undefined),
  prismaMock: {
    automation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    automationContext: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    automationLog: { create: vi.fn() },
    integrationWebhook: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    deal: {
      findFirst: vi.fn(),
      // message_received consulta os OPEN do contato antes de disparar.
      findMany: vi.fn(async () => []),
    },
    // `shouldSkipIdleInboundAutomation` lê `conversation.closingProtocolEnabled`
    // pelo org-settings; sem linha vale o padrão (protocolo desligado).
    organizationSetting: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org-fastpath",
  getOrgIdOrThrow: () => "org-fastpath",
}));

vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: (data: unknown) => data,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/sse-bus", () => ({
  sseBus: { publish: vi.fn() },
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForContact: vi.fn(async () => null),
}));

vi.mock("@/services/automations", () => ({
  enqueueAutomation,
  evaluateTrigger: vi.fn(() => true),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/services/integration-webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integration-webhooks")>();
  return {
    ...actual,
    dispatchIntegrationWebhooks,
  };
});

import {
  cancelActiveContextsForContactIfAny,
} from "@/services/automation-context";
import { getHumanAttendanceForContact } from "@/services/attendance-guards";
import {
  fireTrigger,
  resetTriggerExistenceCachesForTests,
} from "@/services/automation-triggers";
import { resetWebhookExistsCacheForTests } from "@/services/integration-webhooks";

describe("cancelActiveContextsForContactIfAny", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("não chama o findMany com steps quando o contato não tem contexto vivo", async () => {
    prismaMock.automationContext.findFirst.mockResolvedValue(null);

    const n = await cancelActiveContextsForContactIfAny("contact-idle");

    expect(n).toBe(0);
    expect(prismaMock.automationContext.findFirst).toHaveBeenCalledWith({
      where: { contactId: "contact-idle", status: { in: ["RUNNING", "PAUSED"] } },
      select: { id: true },
    });
    expect(prismaMock.automationContext.findMany).not.toHaveBeenCalled();
  });

  it("cancela de fato quando existe contexto RUNNING/PAUSED", async () => {
    prismaMock.automationContext.findFirst.mockResolvedValue({ id: "ctx-1" });
    prismaMock.automationContext.findMany.mockResolvedValue([
      { id: "ctx-1", status: "RUNNING" },
    ]);
    prismaMock.automationContext.findUnique.mockResolvedValue({
      id: "ctx-1",
      status: "RUNNING",
    });
    prismaMock.automationContext.update.mockResolvedValue({
      id: "ctx-1",
      organizationId: "org-fastpath",
      contactId: "contact-hot",
      automationId: "a1",
      status: "COMPLETED",
    });

    const n = await cancelActiveContextsForContactIfAny("contact-hot");

    expect(n).toBe(1);
    expect(prismaMock.automationContext.findMany).toHaveBeenCalled();
    expect(prismaMock.automationContext.update).toHaveBeenCalled();
  });
});

describe("fireTrigger fast-path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTriggerExistenceCachesForTests();
    resetWebhookExistsCacheForTests();
    prismaMock.integrationWebhook.findFirst.mockResolvedValue(null);
    prismaMock.automation.findFirst.mockResolvedValue(null);
    prismaMock.automation.findMany.mockResolvedValue([]);
    prismaMock.automationContext.findFirst.mockResolvedValue(null);
    prismaMock.deal.findFirst.mockResolvedValue(null);
    vi.mocked(getHumanAttendanceForContact).mockResolvedValue(null);
  });

  it("retorna cedo e cacheia quando a org não tem webhook nem automação", async () => {
    await fireTrigger("message_sent", { contactId: "c1", data: {} });
    await fireTrigger("message_sent", { contactId: "c2", data: {} });

    expect(prismaMock.integrationWebhook.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.automation.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.automation.findMany).not.toHaveBeenCalled();
    expect(prismaMock.integrationWebhook.findMany).not.toHaveBeenCalled();
    expect(dispatchIntegrationWebhooks).not.toHaveBeenCalled();
    expect(enqueueAutomation).not.toHaveBeenCalled();
  });

  it("dispara webhook e não lista automações quando só há hook", async () => {
    prismaMock.integrationWebhook.findFirst.mockResolvedValue({ id: "hook-1" });

    await fireTrigger("message_sent", { contactId: "c1", data: {} });

    expect(dispatchIntegrationWebhooks).toHaveBeenCalledTimes(1);
    expect(prismaMock.automation.findMany).not.toHaveBeenCalled();
    expect(enqueueAutomation).not.toHaveBeenCalled();
  });

  it("segue o caminho completo quando há automação ativa no evento", async () => {
    prismaMock.automation.findFirst.mockResolvedValue({ id: "auto-1" });
    prismaMock.automation.findMany.mockResolvedValue([
      {
        id: "auto-1",
        name: "On send",
        triggerType: "message_sent",
        triggerConfig: {},
      },
    ]);

    await fireTrigger("stage_changed", {
      contactId: "c1",
      data: { fromStageId: "a", toStageId: "b" },
    });

    expect(dispatchIntegrationWebhooks).not.toHaveBeenCalled();
    expect(prismaMock.automation.findMany).toHaveBeenCalled();
    expect(enqueueAutomation).toHaveBeenCalledWith(
      "auto-1",
      expect.objectContaining({ contactId: "c1", event: "stage_changed" }),
    );
  });

  it("conversation_created dispara mesmo com assignee — inicio-pipe no inbound", async () => {
    vi.mocked(getHumanAttendanceForContact).mockResolvedValue({
      conversationId: "conv-1",
      hasHumanReply: false,
      assignedToId: "ai-1",
      assigneeType: "AI",
      humanAttending: false,
      suppressAutomation: true,
    });
    prismaMock.automation.findFirst.mockResolvedValue({ id: "pipe" });
    prismaMock.automation.findMany.mockResolvedValue([
      {
        id: "pipe",
        name: "inicio - pipe",
        triggerType: "conversation_created",
        triggerConfig: { channelScope: "all" },
      },
    ]);

    await fireTrigger("conversation_created", {
      contactId: "c1",
      data: { channel: "whatsapp", conversationId: "conv-1" },
    });

    expect(enqueueAutomation).toHaveBeenCalledWith(
      "pipe",
      expect.objectContaining({ contactId: "c1", event: "conversation_created" }),
    );
  });

  it("conversation_created anexa deal OPEN — move_stage do inicio-pipe", async () => {
    prismaMock.deal.findFirst.mockResolvedValue({
      id: "d1",
      status: "OPEN",
      stageId: "s1",
      stage: { pipelineId: "p1" },
    });
    prismaMock.automation.findFirst.mockResolvedValue({ id: "pipe" });
    prismaMock.automation.findMany.mockResolvedValue([
      {
        id: "pipe",
        name: "inicio - pipe",
        triggerType: "conversation_created",
        triggerConfig: { channelScope: "all" },
      },
    ]);

    await fireTrigger("conversation_created", {
      contactId: "c1",
      data: { channel: "whatsapp", conversationId: "conv-1" },
    });

    expect(enqueueAutomation).toHaveBeenCalledWith(
      "pipe",
      expect.objectContaining({
        contactId: "c1",
        dealId: "d1",
        event: "conversation_created",
        data: expect.objectContaining({
          stageId: "s1",
          pipelineId: "p1",
          dealStatus: "OPEN",
        }),
      }),
    );
  });

  it("message_received dispara mesmo com responsável no ticket", async () => {
    vi.mocked(getHumanAttendanceForContact).mockResolvedValue({
      conversationId: "conv-1",
      hasHumanReply: true,
      assignedToId: "human-1",
      assigneeType: "HUMAN",
      humanAttending: true,
      suppressAutomation: true,
    });
    prismaMock.automation.findFirst.mockResolvedValue({ id: "move" });
    prismaMock.automation.findMany.mockResolvedValue([
      {
        id: "move",
        name: "mensagem recebida move etapa",
        triggerType: "message_received",
        triggerConfig: {},
      },
    ]);

    await fireTrigger("message_received", {
      contactId: "c1",
      data: {
        channel: "WhatsApp",
        channelId: "ch-1",
        conversationId: "conv-1",
        content: "quero informações do curso",
      },
    });

    expect(enqueueAutomation).toHaveBeenCalledWith(
      "move",
      expect.objectContaining({ contactId: "c1", event: "message_received" }),
    );
  });

  it("stage_changed de duplicata com contexto já gravado não dispara de novo", async () => {
    prismaMock.automation.findFirst.mockResolvedValue({ id: "auto-1" });
    prismaMock.automation.findMany.mockResolvedValue([
      {
        id: "auto-1",
        name: "Na etapa",
        triggerType: "stage_changed",
        triggerConfig: {},
      },
    ]);
    prismaMock.deal.findMany.mockResolvedValue([
      {
        id: "origin",
        intentionalDuplicate: false,
        duplicatedFromDealId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "copy",
        intentionalDuplicate: true,
        duplicatedFromDealId: "origin",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.automationContext.findFirst.mockImplementation(
      async (args: { where?: { status?: string } }) =>
        args?.where?.status ? null : { id: "ctx-done" },
    );

    await fireTrigger("stage_changed", {
      contactId: "c1",
      dealId: "copy",
      data: { toStageId: "stage-1" },
    });

    expect(enqueueAutomation).not.toHaveBeenCalled();
  });
});
