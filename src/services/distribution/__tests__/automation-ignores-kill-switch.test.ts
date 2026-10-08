/**
 * distribution.enabled=false para o sorteio SYSTEM.
 * O passo da automação, a IA e o manual continuam atribuindo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const isDistributionEnabled = vi.fn(async () => false);
const getDistributionResponsibles = vi.fn(async () => []);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: "c1" })),
    },
    department: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => [
        { id: "dept_retencao", distributionMode: "smart" },
      ]),
    },
    deal: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
    contact: { findUnique: vi.fn(async () => null), update: vi.fn() },
    distributionLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "log" })),
      update: vi.fn(async () => ({})),
    },
    distributionPending: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    user: { findUnique: vi.fn(async () => ({ type: "HUMAN" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org_teste",
}));

vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: async () => true,
}));

vi.mock("../enabled", () => ({
  isDistributionEnabled: () => isDistributionEnabled(),
}));

vi.mock("../responsibles", () => ({
  getDistributionResponsibles: (...a: unknown[]) =>
    (getDistributionResponsibles as (...args: unknown[]) => unknown)(...a),
}));

vi.mock("@/services/activity-log", () => ({
  logEvent: async () => undefined,
}));

vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: () => undefined,
}));

vi.mock("@/lib/channels/retired-whatsapp", () => ({
  isRetiredWhatsAppChannel: () => false,
}));

vi.mock("@/services/deals", () => ({
  assignDealOwner: async () => undefined,
  propagateOwnerToContactAndChat: async () => undefined,
  syncOwnershipForContact: async () => null,
}));

vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForConversation: async () => null,
}));

const { executeDistribution } = await import("../engine");

describe("distribuição ligada só no bloco e na ferramenta", () => {
  beforeEach(() => {
    isDistributionEnabled.mockResolvedValue(true);
    getDistributionResponsibles.mockClear();
  });

  it("SYSTEM não sorteia mesmo com o motor ligado", async () => {
    const result = await executeDistribution({
      triggerSource: "SYSTEM",
      conversationId: "c1",
      contactId: "ct1",
    });
    expect(result.reason).toBe("DISTRIBUTION_DISABLED");
    expect(getDistributionResponsibles).not.toHaveBeenCalled();
  });

  it("AUTOMATION com o motor desligado não atribui", async () => {
    isDistributionEnabled.mockResolvedValue(false);
    const result = await executeDistribution({
      triggerSource: "AUTOMATION",
      departmentIds: ["dept_retencao"],
    });
    expect(result.reason).toBe("DISTRIBUTION_DISABLED");
    expect(getDistributionResponsibles).not.toHaveBeenCalled();
  });

  it("AUTOMATION com o motor ligado avalia o departamento do passo", async () => {
    const result = await executeDistribution({
      triggerSource: "AUTOMATION",
      departmentIds: ["dept_retencao"],
    });
    expect(result.reason).not.toBe("DISTRIBUTION_DISABLED");
    expect(getDistributionResponsibles).toHaveBeenCalledWith(
      expect.objectContaining({ departmentIds: ["dept_retencao"] }),
    );
  });
});
