import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const getDistributionResponsibles = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

vi.mock("@/services/distribution/responsibles", () => ({
  getDistributionResponsibles: (...a: unknown[]) =>
    getDistributionResponsibles(...a),
}));

const { isAssigneeCurrentlyEligible, shouldKeepAssigneeInAttendance } =
  await import("../assignee-eligibility");

const ACOLHIMENTO = "dept_acolhimento";
const RETENCAO = "dept_retencao";
const DANUBIA = "user_danubia";

/** Espelha `getDistributionResponsibles`: fora do pool → DEPARTMENT_MISMATCH. */
function respondWithScope(memberOf: string[]) {
  getDistributionResponsibles.mockImplementation(
    async (opts: { departmentIds?: string[] } = {}) => {
      const scope = opts.departmentIds ?? [];
      const inDepartment =
        scope.length === 0 || scope.some((id) => memberOf.includes(id));
      return [
        {
          userId: DANUBIA,
          eligible: inDepartment,
          blockedReasons: inDepartment ? [] : ["DEPARTMENT_MISMATCH"],
        },
      ];
    },
  );
}

describe("isAssigneeCurrentlyEligible — fronteira de departamento", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue({ id: DANUBIA, type: "HUMAN" });
    respondWithScope([ACOLHIMENTO]);
  });

  it("mantém o dono quando nenhum departamento foi pedido", async () => {
    const check = await isAssigneeCurrentlyEligible(DANUBIA);

    expect(check.eligible).toBe(true);
    expect(getDistributionResponsibles).toHaveBeenCalledWith({});
  });

  it("mantém o dono que é membro do departamento pedido", async () => {
    const check = await isAssigneeCurrentlyEligible(DANUBIA, [ACOLHIMENTO]);

    expect(check.eligible).toBe(true);
    expect(getDistributionResponsibles).toHaveBeenCalledWith({
      departmentIds: [ACOLHIMENTO],
    });
  });

  it("recusa o dono de fora do departamento pedido pelo passo da automação", async () => {
    const check = await isAssigneeCurrentlyEligible(DANUBIA, [RETENCAO]);

    expect(check.eligible).toBe(false);
    expect(check.isAi).toBe(false);
    expect(check.blockedReasons).toContain("DEPARTMENT_MISMATCH");
  });

  it("trata pool vazio como ausência de restrição", async () => {
    const check = await isAssigneeCurrentlyEligible(DANUBIA, []);

    expect(check.eligible).toBe(true);
    expect(getDistributionResponsibles).toHaveBeenCalledWith({});
  });
});

/**
 * Incidente 08/set/26 + 09/set/26 (#359447): o atendente perdia o aluno
 * no inbound (almoço / outro departamento). Conversa já respondida fica
 * com quem está atendendo; sem reply, redistribui (caso Danubia / offline).
 */
describe("shouldKeepAssigneeInAttendance", () => {
  const base = {
    departmentScoped: true,
    eligibleInDepartment: false,
    eligibleOutsideDepartment: true,
    hasHumanReply: true,
    isAi: false,
  };

  it("conversa já respondida por humano de outro departamento: mantém o dono", () => {
    expect(shouldKeepAssigneeInAttendance(base)).toBe(true);
  });

  it("dono de outro departamento SEM resposta humana: redistribui", () => {
    expect(
      shouldKeepAssigneeInAttendance({ ...base, hasHumanReply: false }),
    ).toBe(false);
  });

  it("dono em almoço/offline COM resposta humana: mantém o dono", () => {
    expect(
      shouldKeepAssigneeInAttendance({
        ...base,
        departmentScoped: false,
        eligibleInDepartment: false,
        eligibleOutsideDepartment: false,
      }),
    ).toBe(true);
  });

  it("dono offline SEM resposta humana: redistribui", () => {
    expect(
      shouldKeepAssigneeInAttendance({
        ...base,
        hasHumanReply: false,
        eligibleOutsideDepartment: false,
      }),
    ).toBe(false);
  });

  it("dono elegível no próprio departamento COM reply: mantém", () => {
    expect(
      shouldKeepAssigneeInAttendance({ ...base, eligibleInDepartment: true }),
    ).toBe(true);
  });

  it("passo sem departamento e sem reply não aciona a salvaguarda", () => {
    expect(
      shouldKeepAssigneeInAttendance({
        ...base,
        departmentScoped: false,
        hasHumanReply: false,
      }),
    ).toBe(false);
  });

  it("IA nunca é preservada como atendimento humano", () => {
    expect(shouldKeepAssigneeInAttendance({ ...base, isAi: true })).toBe(false);
  });
});
