/**
 * "Distribuir p/ departamento" numa org em Por Leads usa o rodízio por leads
 * só com membros do departamento (Comercial Cruzeiro, #106732): antes ia
 * para o Inteligente desligado e voltava "Distribuição desligada".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mode: "smart" | "leads" = "leads";
vi.mock("../mode", () => ({ getOrgDistributionMode: async () => mode }));

const smart = vi.fn(async () => ({
  success: false,
  reason: "DISTRIBUTION_DISABLED" as const,
  selectedUserId: null,
  selectedUserName: null,
  evaluated: [],
}));
vi.mock("../engine", () => ({ executeDistribution: smart }));

const leads = vi.fn(async (_input: unknown) => ({
  success: true,
  reason: "ASSIGNED" as const,
  selectedUserId: "u_marilia",
  selectedUserName: "Marília Souza",
}));
vi.mock("../leads/engine", () => ({ executeLeadsDistribution: leads }));

const conv = { departmentId: "d_comercial" as string | null, assignedToId: "u_old" as string | null, contactId: "c1" };
const update = vi.fn(async () => ({ id: "conv1" }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: async () => conv, update },
    departmentMember: {
      findMany: async () => [{ userId: "u_marilia" }, { userId: "u_ana" }, { userId: "u_marilia" }],
    },
  },
}));
const logDept = vi.fn(async () => {});
vi.mock("@/services/conversation-department-event", () => ({
  logConversationDepartmentChange: logDept,
}));

const { executeManualDistribution, leadsResultAsDistribution } = await import("../manual-dispatch");

const base = {
  conversationId: "conv1",
  contactId: "c1",
  departmentIds: ["d_academico"],
  reassign: true,
  triggerSource: "MANUAL" as const,
};

describe("executeManualDistribution", () => {
  beforeEach(() => {
    mode = "leads";
    conv.departmentId = "d_comercial";
    conv.assignedToId = "u_old";
    smart.mockClear();
    leads.mockClear();
    update.mockClear();
    logDept.mockClear();
  });

  it("org em Por Leads: rodízio por leads só com membros do departamento", async () => {
    const r = await executeManualDistribution(base);
    expect(smart).not.toHaveBeenCalled();
    expect(leads).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv1",
        triggerSource: "MANUAL",
        reassign: true,
        onlyUserIds: ["u_marilia", "u_ana"],
      }),
    );
    expect(r).toMatchObject({ success: true, reason: "ASSIGNED", selectedUserId: "u_marilia" });
  });

  it("marca a conversa com o departamento escolhido e registra a troca", async () => {
    await executeManualDistribution(base);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { departmentId: "d_academico" } }),
    );
    expect(logDept).toHaveBeenCalledWith(
      expect.objectContaining({ fromDepartmentId: "d_comercial", toDepartmentId: "d_academico" }),
    );
  });

  it("departamento já certo (transferência): não regrava", async () => {
    conv.departmentId = "d_academico";
    await executeManualDistribution(base);
    expect(update).not.toHaveBeenCalled();
    expect(leads).toHaveBeenCalled();
  });

  it("transferência com consultor escolhido (reassign=false) mantém quem está", async () => {
    const r = await executeManualDistribution({ ...base, reassign: false });
    expect(leads).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: true, selectedUserId: "u_old" });
  });

  it("org em Inteligente: segue no motor de sempre", async () => {
    mode = "smart";
    await executeManualDistribution(base);
    expect(smart).toHaveBeenCalled();
    expect(leads).not.toHaveBeenCalled();
  });

  it("automação e manual sem departamento: segue no motor de sempre", async () => {
    await executeManualDistribution({ ...base, triggerSource: "AUTOMATION" });
    await executeManualDistribution({ ...base, departmentIds: [] });
    expect(smart).toHaveBeenCalledTimes(2);
    expect(leads).not.toHaveBeenCalled();
  });
});

describe("leadsResultAsDistribution", () => {
  const r = (reason: string) =>
    leadsResultAsDistribution({
      success: false,
      reason: reason as never,
      selectedUserId: null,
      selectedUserName: null,
    }).reason;

  it("traduz os motivos para o que a tela entende", () => {
    expect(r("DONO_PRESERVADO")).toBe("ASSIGNED");
    expect(r("NO_ELIGIBLE_PARTICIPANT")).toBe("NO_ELIGIBLE_PARTICIPANT");
    expect(r("NO_TARGET")).toBe("NO_ELIGIBLE_PARTICIPANT");
    expect(r("DISTRIBUTION_DISABLED")).toBe("DISTRIBUTION_DISABLED");
  });
});
