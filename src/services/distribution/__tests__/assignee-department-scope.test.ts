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
 * Incidente 08/set/26: o atendente perdia o aluno da tela no meio da conversa
 * porque o passo pedia outro departamento. Conversa trabalhada fica com quem
 * está atendendo; sem resposta humana, redistribui (caso Danubia).
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

  it("dono offline não é protegido — barreira não é o departamento", () => {
    expect(
      shouldKeepAssigneeInAttendance({
        ...base,
        eligibleOutsideDepartment: false,
      }),
    ).toBe(false);
  });

  it("dono elegível no próprio departamento não precisa da salvaguarda", () => {
    expect(
      shouldKeepAssigneeInAttendance({ ...base, eligibleInDepartment: true }),
    ).toBe(false);
  });

  it("passo sem departamento não aciona a salvaguarda", () => {
    expect(
      shouldKeepAssigneeInAttendance({ ...base, departmentScoped: false }),
    ).toBe(false);
  });

  it("IA nunca é preservada como atendimento humano", () => {
    expect(shouldKeepAssigneeInAttendance({ ...base, isAi: true })).toBe(false);
  });
});
