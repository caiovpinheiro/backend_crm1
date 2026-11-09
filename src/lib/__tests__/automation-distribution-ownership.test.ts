/**
 * "O que distribuir" do passo `execute_distribution` (`cfg.ownershipScope`).
 * Ausente = segue `Department.keepDealOwner` (fluxos antigos não mudam).
 */
import { describe, expect, it } from "vitest";

import { readStepKeepDealOwner, readStepOwnershipScope } from "../automation-workflow";

describe("readStepKeepDealOwner", () => {
  it("config antiga (sem campo) segue o departamento", () => {
    expect(readStepOwnershipScope({})).toBe("department");
    expect(readStepKeepDealOwner({})).toBeNull();
    expect(readStepKeepDealOwner(null)).toBeNull();
  });

  it("somente a conversa mantém o dono do negócio", () => {
    expect(readStepKeepDealOwner({ ownershipScope: "conversation_only" })).toBe(true);
  });

  it("conversa e negócio troca o dono", () => {
    expect(readStepKeepDealOwner({ ownershipScope: "conversation_and_deal" })).toBe(false);
  });

  it("valor desconhecido cai no departamento", () => {
    expect(readStepKeepDealOwner({ ownershipScope: "x" })).toBeNull();
    expect(readStepKeepDealOwner({ ownershipScope: "department" })).toBeNull();
  });
});
