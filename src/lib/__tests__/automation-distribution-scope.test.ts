/**
 * Escopo de departamento do passo `execute_distribution`.
 *
 * Sintoma (Cruzeiro EaD, set/26): automação com o campo de departamento vazio
 * distribuía org-wide mesmo quando a conversa já estava num departamento — o
 * executor mandava `departmentIds: null` e só `resolveDepartmentScope()` leria
 * o departamento da conversa (e só com `distribution.respectDepartment` on).
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
 * A origem do departamento decide o que acontece quando o pool fica sem
 * ninguém elegível. O executor trata as duas origens iguais: pool fechado,
 * o lead espera na fila daquele departamento (sem fallback org-wide).
 * `origin` continua no contrato para diagnóstico e para a UI do canvas.
 */
describe("resolveStepDistributionScope — origem do departamento", () => {
  /** Espelha a decisão do executor: só herdado libera o fallback. */
  function allowsOrgWideFallback(
    cfg: unknown,
    conversationDepartmentId: string | null,
  ): boolean {
    return (
      resolveStepDistributionScope(cfg, conversationDepartmentId).origin ===
      "inherited"
    );
  }

  it("departamento escolhido no nó é regra: pool fechado, sem fallback", () => {
    const scope = resolveStepDistributionScope(
      { departmentIds: [RETENCAO] },
      ACOLHIMENTO,
    );

    expect(scope).toEqual({ departmentIds: [RETENCAO], origin: "explicit" });
    expect(allowsOrgWideFallback({ departmentIds: [RETENCAO] }, ACOLHIMENTO)).toBe(
      false,
    );
  });

  it("campo vazio com conversa em departamento: herda (origin inherited)", () => {
    const scope = resolveStepDistributionScope({}, ACOLHIMENTO);

    expect(scope).toEqual({
      departmentIds: [ACOLHIMENTO],
      origin: "inherited",
    });
    expect(allowsOrgWideFallback({ departmentIds: [] }, ACOLHIMENTO)).toBe(true);
  });

  it("campo vazio e conversa sem departamento: org-wide direto", () => {
    const scope = resolveStepDistributionScope({ departmentIds: [] }, null);

    expect(scope).toEqual({ departmentIds: null, origin: "org-wide" });
    // Já é org-wide: não há departamento para o fallback resgatar.
    expect(allowsOrgWideFallback({}, null)).toBe(false);
  });

  it("retrocompat: departmentId singular também é escolha do operador", () => {
    expect(
      resolveStepDistributionScope({ departmentId: RETENCAO }, ACOLHIMENTO),
    ).toEqual({ departmentIds: [RETENCAO], origin: "explicit" });
  });
});
