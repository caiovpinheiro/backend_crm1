/**
 * Departamento do lead → só os membros daquele departamento.
 * Vale para qualquer id (departamento criado depois), sem lista de nomes
 * e sem cair no pool da org quando o lead já tem departamento.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOVO = "dept_criado_depois";
const ATENDIMENTO = "dept_atendimento";
const CONV = "conv_1";

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
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: CONV })),
    },
    department: {
      findUnique: (...a: unknown[]) => departmentFindUnique(...a),
      findMany: (...a: unknown[]) => departmentFindMany(...a),
    },
    deal: { findFirst: vi.fn(async () => null) },
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
    activityEvent: { findFirst: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ type: "HUMAN" })) },
    distributionResponsible: { upsert: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: (...a: unknown[]) => getOrgSettingBool(...a),
  getOrgSetting: (...a: unknown[]) => getOrgSetting(...a),
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org_teste",
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
  assignDealOwner: async () => undefined,
  propagateOwnerToContactAndChat: async () => undefined,
  syncOwnershipForContact: async () => undefined,
}));

vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForConversation: async () => null,
}));

const { executeDistribution, simulateDistribution } = await import("../engine");

function person(userId: string, eligible: boolean) {
  return {
    userId,
    name: userId,
    eligible,
    blockedReasons: eligible ? [] : ["DEPARTMENT_MISMATCH"],
    queueCount: 0,
    volume: 1,
  };
}

function selectKeys(select: Record<string, unknown> | undefined): string {
  return Object.keys(select ?? {}).sort().join(",");
}

describe("distribuição pelo departamento do lead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSettingBool.mockResolvedValue(false);
    getOrgSetting.mockResolvedValue(ATENDIMENTO);
    departmentFindMany.mockResolvedValue([]);
    conversationFindUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        const keys = selectKeys(args.select);
        if (keys === "channelRef") return { channelRef: null };
        if (keys === "contactId") return { contactId: null };
        if (keys.includes("assignedVia")) {
          return { assignedToId: null, contactId: null, assignedVia: null };
        }
        if (keys.includes("assignedTo")) {
          return {
            assignedToId: null,
            departmentId: NOVO,
            contactId: null,
            assignedTo: null,
          };
        }
        if (keys === "departmentId") return { departmentId: NOVO };
        if (keys === "department") return { department: { name: "Comercial Novo" } };
        if (keys === "lastInboundAt") return { lastInboundAt: new Date() };
        return { departmentId: NOVO, contactId: null, assignedToId: null };
      },
    );
  });

  it("departamento novo da conversa limita o pool aos membros, mesmo com respectDepartment desligado", async () => {
    departmentFindUnique.mockResolvedValue({
      id: NOVO,
      distributionEnabled: true,
      distributionMode: "smart",
    });
    getDistributionResponsibles.mockResolvedValue([
      person("membro_do_novo", true),
      person("de_outro_depto", false),
    ]);

    const result = await simulateDistribution({
      conversationId: CONV,
      allowOrgWideFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.selectedUserId).toBe("membro_do_novo");
    expect(getDistributionResponsibles).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: NOVO }),
    );
    expect(getOrgSettingBool).not.toHaveBeenCalled();
    expect(getOrgSetting).not.toHaveBeenCalled();
  });

  it("id explícito de departamento novo entra no pool, sem depender do nome", async () => {
    departmentFindUnique.mockResolvedValue({
      id: NOVO,
      distributionEnabled: true,
      distributionMode: "smart",
    });
    getDistributionResponsibles.mockResolvedValue([person("wesley", true)]);

    const result = await simulateDistribution({ departmentId: NOVO });

    expect(result.selectedUserId).toBe("wesley");
    expect(getDistributionResponsibles).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: NOVO }),
    );
  });

  it("lead sem departamento vai para qualquer elegível, não para um departamento fixo", async () => {
    getOrgSettingBool.mockResolvedValue(true);
    getOrgSetting.mockResolvedValue(ATENDIMENTO);
    getDistributionResponsibles.mockResolvedValue([
      person("acolhimento", true),
      person("retencao", true),
      person("atendimento", true),
    ]);

    const result = await simulateDistribution({});

    expect(result.success).toBe(true);
    expect(getDistributionResponsibles).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: null }),
    );
    expect(getOrgSettingBool).not.toHaveBeenCalled();
    expect(getOrgSetting).not.toHaveBeenCalled();
  });

  it("departamento com distribuição desligada não entrega para o resto da org", async () => {
    departmentFindUnique.mockResolvedValue({
      id: NOVO,
      distributionEnabled: false,
      distributionMode: "smart",
    });

    const result = await executeDistribution({
      conversationId: CONV,
      triggerSource: "SYSTEM",
      allowOrgWideFallback: true,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("NO_DEPARTMENT");
    expect(result.selectedUserId).toBeNull();
    expect(getDistributionResponsibles).not.toHaveBeenCalled();
  });

  it("sem elegível no departamento não vaza para outro departamento", async () => {
    departmentFindUnique.mockResolvedValue({
      id: NOVO,
      distributionEnabled: true,
      distributionMode: "smart",
    });
    getDistributionResponsibles.mockResolvedValue([
      person("offline_do_novo", false),
    ]);

    const result = await executeDistribution({
      conversationId: CONV,
      triggerSource: "AUTOMATION",
      allowOrgWideFallback: false,
    });

    expect(result.reason).toBe("NO_ELIGIBLE_RESPONSIBLE");
    expect(getDistributionResponsibles).toHaveBeenCalledTimes(1);
    expect(getDistributionResponsibles).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: NOVO }),
    );
  });

  it("departamento em modo leads fica fora da distribuição inteligente", async () => {
    departmentFindUnique.mockResolvedValue({
      id: NOVO,
      distributionEnabled: true,
      distributionMode: "leads",
    });

    const result = await executeDistribution({
      conversationId: CONV,
      triggerSource: "SYSTEM",
    });

    expect(result.reason).toBe("NO_DEPARTMENT");
    expect(getDistributionResponsibles).not.toHaveBeenCalled();
  });
});
