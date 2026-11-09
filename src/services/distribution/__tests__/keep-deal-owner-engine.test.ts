/**
 * "Manter dono do negócio" no motor inteligente: com a regra ligada o
 * escolhido atende só a conversa; desligada, o responsável único de sempre.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DEPT = "dept_financeiro";
const CONV = "conv_1";
const assignDealOwner = vi.fn(async (..._a: unknown[]) => undefined);
const resolveKeepDealOwner = vi.fn();
const assignConversationOnly = vi.fn(async (..._a: unknown[]) => null);
const txContactUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const txDealUpdateMany = vi.fn(async (..._a: unknown[]) => ({ count: 1 }));
const txConversationUpdate = vi.fn(async (..._a: unknown[]) => ({ id: CONV }));
const tx = {
  conversation: { update: (...a: unknown[]) => txConversationUpdate(...a) },
  contact: { update: (...a: unknown[]) => txContactUpdate(...a) },
  deal: { updateMany: (...a: unknown[]) => txDealUpdateMany(...a) },
};

const getDistributionResponsibles = vi.fn();
const getOrgSettingBool = vi.fn();
const getOrgSetting = vi.fn();
const conversationFindUnique = vi.fn();
const departmentFindUnique = vi.fn();
const departmentFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findUnique: (...a: unknown[]) => conversationFindUnique(...a),
      findFirst: vi.fn(async (..._a: unknown[]) => null),
      update: vi.fn(async (..._a: unknown[]) => ({ id: CONV })),
    },
    department: {
      findUnique: (...a: unknown[]) => departmentFindUnique(...a),
      findMany: (...a: unknown[]) => departmentFindMany(...a),
    },
    deal: {
      findFirst: vi.fn(async (..._a: unknown[]) => null),
      findMany: vi.fn(async (..._a: unknown[]) => [{ id: "deal_1" }]),
      findUnique: vi.fn(async (..._a: unknown[]) => ({ contactId: "ct_1" })),
    },
    distributionLog: {
      findFirst: vi.fn(async (..._a: unknown[]) => null),
      create: vi.fn(async (..._a: unknown[]) => ({ id: "log" })),
      update: vi.fn(async (..._a: unknown[]) => ({})),
    },
    distributionPending: {
      findFirst: vi.fn(async (..._a: unknown[]) => null),
      create: vi.fn(async (..._a: unknown[]) => ({})),
      update: vi.fn(async (..._a: unknown[]) => ({})),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    activityEvent: { findFirst: vi.fn(async (..._a: unknown[]) => null) },
    user: { findUnique: vi.fn(async (..._a: unknown[]) => ({ type: "HUMAN" })) },
    distributionResponsible: { upsert: vi.fn(async (..._a: unknown[]) => ({})) },
    contact: { findUnique: vi.fn(async (..._a: unknown[]) => ({ assignedTo: { type: "HUMAN" } })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      typeof fn === "function" ? fn(tx) : undefined,
    ),
  },
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: (...a: unknown[]) => getOrgSettingBool(...a),
  getOrgSetting: (...a: unknown[]) => getOrgSetting(...a),
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org_teste",
  getRequestContext: () => undefined,
}));

vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: async () => true,
}));

vi.mock("../enabled", () => ({
  isDistributionEnabled: async () => true,
}));

vi.mock("../responsibles", () => ({
  getDistributionResponsibles: (...a: unknown[]) =>
    getDistributionResponsibles(...a),
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
  assignDealOwner: (...a: unknown[]) => assignDealOwner(...a),
  propagateOwnerToContactAndChat: async () => undefined,
  syncOwnershipForContact: async () => null,
  assignOwnerToContactClusterTx: async () => ({ dealIds: [], pipelineIds: [] }),
  invalidateBoardsForPipelines: async () => undefined,
}));

vi.mock("@/lib/channel-session", () => ({
  getConversationSession: async () => ({ active: false }),
}));

vi.mock("../deal-owner-scope", () => ({
  resolveKeepDealOwner: (...a: unknown[]) => resolveKeepDealOwner(...a),
  assignConversationOnly: (...a: unknown[]) => assignConversationOnly(...a),
}));

vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForConversation: async () => null,
}));

const { executeDistribution } = await import("../engine");

function selectKeys(select: Record<string, unknown> | undefined): string {
  return Object.keys(select ?? {}).sort().join(",");
}

function mockConversation(assignedToId: string | null) {
  conversationFindUnique.mockImplementation(
    async (args: { select?: Record<string, unknown> }) => {
      const keys = selectKeys(args.select);
      if (keys === "channelRef") return { channelRef: null };
      if (keys.includes("assignedTo") && keys.includes("departmentId")) {
        return {
          assignedToId,
          departmentId: DEPT,
          contactId: "ct_1",
          assignedTo: assignedToId ? { type: "HUMAN" } : null,
        };
      }
      if (keys === "lastInboundAt" || keys.includes("lastInboundAt")) {
        return { id: CONV, contactId: "ct_1", channel: "WHATSAPP", channelId: null, lastInboundAt: null };
      }
      return { departmentId: DEPT, contactId: "ct_1", assignedToId };
    },
  );
}

describe("motor inteligente — manter dono do negócio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSettingBool.mockResolvedValue(false);
    getOrgSetting.mockResolvedValue(null);
    departmentFindMany.mockResolvedValue([{ id: DEPT, distributionMode: "smart" }]);
    departmentFindUnique.mockResolvedValue({ id: DEPT, distributionEnabled: true, distributionMode: "smart" });
    getDistributionResponsibles.mockResolvedValue([
      { userId: "financeiro", name: "Financeiro", eligible: true, blockedReasons: [], queueCount: 0, volume: 1 },
    ]);
  });

  it("regra ligada: atribui só a conversa e não chama assignDealOwner", async () => {
    mockConversation(null);
    resolveKeepDealOwner.mockResolvedValue(true);

    const result = await executeDistribution({
      conversationId: CONV,
      contactId: "ct_1",
      dealId: "deal_1",
      departmentIds: [DEPT],
      triggerSource: "AUTOMATION",
    });

    expect(result.success).toBe(true);
    expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: "financeiro" });
    expect(assignDealOwner).not.toHaveBeenCalled();
    expect(resolveKeepDealOwner).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV, departmentId: DEPT }),
    );
  });

  it("regra desligada: segue o responsável único (dono do negócio muda)", async () => {
    mockConversation(null);
    resolveKeepDealOwner.mockResolvedValue(false);

    await executeDistribution({
      conversationId: CONV,
      contactId: "ct_1",
      dealId: "deal_1",
      departmentIds: [DEPT],
      triggerSource: "AUTOMATION",
    });

    expect(assignDealOwner).toHaveBeenCalledWith("deal_1", "financeiro");
    expect(assignConversationOnly).not.toHaveBeenCalled();
  });

  it("transferência para o departamento (reassign) solta só a conversa", async () => {
    mockConversation("vendedor");
    resolveKeepDealOwner.mockResolvedValue(true);

    await executeDistribution({
      conversationId: CONV,
      contactId: "ct_1",
      departmentId: DEPT,
      departmentIds: [DEPT],
      reassign: true,
      keepDealOwner: true,
      triggerSource: "MANUAL",
    });

    expect(txConversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedToId: null } }),
    );
    expect(txContactUpdate).not.toHaveBeenCalled();
    expect(txDealUpdateMany).not.toHaveBeenCalled();
    expect(resolveKeepDealOwner).toHaveBeenCalledWith(
      expect.objectContaining({ override: true }),
    );
    expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: "financeiro" });
    expect(assignDealOwner).not.toHaveBeenCalled();
  });

  it("reassign sem a regra limpa contato e negócio, como hoje", async () => {
    mockConversation("vendedor");
    resolveKeepDealOwner.mockResolvedValue(false);

    await executeDistribution({
      conversationId: CONV,
      contactId: "ct_1",
      departmentId: DEPT,
      departmentIds: [DEPT],
      reassign: true,
      triggerSource: "MANUAL",
    });

    expect(txContactUpdate).toHaveBeenCalled();
    expect(txDealUpdateMany).toHaveBeenCalled();
  });
});
