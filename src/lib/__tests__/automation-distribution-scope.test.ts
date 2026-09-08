/**
 * Escopo de departamento do passo `execute_distribution`.
 *
 * Sintoma (Cruzeiro EaD, set/26): automação com o campo de departamento vazio
 * distribuía org-wide mesmo quando a conversa já estava num departamento — o
 * executor mandava `departmentIds: null` e só `resolveDepartmentScope()` leria
 * o departamento da conversa (e só com `distribution.respectDepartment` on).
 */
import { describe, expect, it } from "vitest";

import { readStepDistributionDepartmentIds } from "../automation-workflow";

const ACOLHIMENTO = "dept_acolhimento";
const RETENCAO = "dept_retencao";

describe("readStepDistributionDepartmentIds", () => {
  it("campo preenchido manda o que o operador escolheu", () => {
    expect(
      readStepDistributionDepartmentIds(
        { departmentIds: [ACOLHIMENTO, RETENCAO] },
        null,
      ),
    ).toEqual([ACOLHIMENTO, RETENCAO]);
  });

  it("campo preenchido ignora o departamento da conversa", () => {
    expect(
      readStepDistributionDepartmentIds({ departmentIds: [RETENCAO] }, ACOLHIMENTO),
    ).toEqual([RETENCAO]);
  });

  it("campo vazio herda o departamento da conversa", () => {
    expect(readStepDistributionDepartmentIds({}, ACOLHIMENTO)).toEqual([
      ACOLHIMENTO,
    ]);
    expect(
      readStepDistributionDepartmentIds({ departmentIds: [] }, ACOLHIMENTO),
    ).toEqual([ACOLHIMENTO]);
  });

  it("campo vazio e conversa sem departamento = org-wide", () => {
    expect(readStepDistributionDepartmentIds({ departmentIds: [] }, null)).toBeNull();
    expect(readStepDistributionDepartmentIds({}, "")).toBeNull();
    expect(readStepDistributionDepartmentIds({})).toBeNull();
  });

  it("descarta lixo do config e deduplica", () => {
    expect(
      readStepDistributionDepartmentIds(
        { departmentIds: ["  ", 42, ` ${ACOLHIMENTO} `, ACOLHIMENTO] },
        RETENCAO,
      ),
    ).toEqual([ACOLHIMENTO]);
  });

  it("retrocompat: departmentId singular continua valendo como escolha", () => {
    expect(
      readStepDistributionDepartmentIds({ departmentId: RETENCAO }, ACOLHIMENTO),
    ).toEqual([RETENCAO]);
  });
});
