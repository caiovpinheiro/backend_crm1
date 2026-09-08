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

const { isAssigneeCurrentlyEligible } = await import("../assignee-eligibility");

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
