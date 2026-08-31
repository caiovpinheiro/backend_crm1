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
    deal: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org-fastpath",
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
});
