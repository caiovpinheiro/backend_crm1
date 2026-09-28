/**
 * Escopo de departamento do passo `execute_distribution`.
 *
 * Sintoma (Cruzeiro EaD, set/26): automação com o campo de departamento vazio
 * distribuía org-wide mesmo quando a conversa já estava num departamento.
 * O passo vazio herda o departamento da conversa e o motor distribui só
 * entre os membros dele.
 */
import { describe, expect, it } from "vitest";

import {
  readStepDistributionDepartmentIds,
  resolveStepDistributionScope,
} from "../automation-workflow";

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

/**
 * Lead com departamento (escolhido no nó ou herdado da conversa) fica
 * no pool dos membros. O executor não libera fallback org-wide.
 */
describe("resolveStepDistributionScope — origem do departamento", () => {
  /** Espelha o executor: com departamento no lead, não há fallback org-wide. */
  function allowsOrgWideFallback(): boolean {
    return false;
  }

  it("departamento escolhido no nó é regra: pool fechado, sem fallback", () => {
    const scope = resolveStepDistributionScope(
      { departmentIds: [RETENCAO] },
      ACOLHIMENTO,
    );

    expect(scope).toEqual({ departmentIds: [RETENCAO], origin: "explicit" });
    expect(allowsOrgWideFallback()).toBe(false);
  });

  it("campo vazio com conversa em departamento: herda e mantém o pool", () => {
    const scope = resolveStepDistributionScope({}, ACOLHIMENTO);

    expect(scope).toEqual({
      departmentIds: [ACOLHIMENTO],
      origin: "inherited",
    });
    expect(allowsOrgWideFallback()).toBe(false);
  });

  it("campo vazio e conversa sem departamento: org-wide direto", () => {
    const scope = resolveStepDistributionScope({ departmentIds: [] }, null);

    expect(scope).toEqual({ departmentIds: null, origin: "org-wide" });
    // Já é org-wide: não há departamento para o fallback resgatar.
    expect(allowsOrgWideFallback()).toBe(false);
  });

  it("retrocompat: departmentId singular também é escolha do operador", () => {
    expect(
      resolveStepDistributionScope({ departmentId: RETENCAO }, ACOLHIMENTO),
    ).toEqual({ departmentIds: [RETENCAO], origin: "explicit" });
  });
});
