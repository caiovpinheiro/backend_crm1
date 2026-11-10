/**
 * Nota do log do passo `execute_distribution` quando ele não distribui.
 * Caso real (DEV, 09/nov/26): `distribution.enabled = false` levava o passo
 * ao ramo "Se não houver atendente" com "OK" no log, sem dizer o motivo.
 */
import { describe, expect, it } from "vitest";

import { distributionSkipNote } from "../automation-workflow";

describe("distributionSkipNote", () => {
  it("modo desligado diz qual modo e onde ligar", () => {
    expect(distributionSkipNote("smart", "DISTRIBUTION_DISABLED")).toBe(
      "Distribuição inteligente desligada na página Distribuição",
    );
    expect(distributionSkipNote("leads", "DISTRIBUTION_DISABLED")).toBe(
      "Distribuição Por Leads desligada na página Distribuição",
    );
  });

  it("sem elegível explica o motivo", () => {
    expect(distributionSkipNote("smart", "NO_ELIGIBLE_RESPONSIBLE")).toMatch(/Ninguém elegível/);
    expect(distributionSkipNote("leads", "NO_ELIGIBLE_PARTICIPANT")).toBe("Sem consultor no rodízio");
  });

  it("motivo desconhecido não inventa nota (log segue 'OK')", () => {
    expect(distributionSkipNote("smart", "ASSIGNED")).toBeUndefined();
    expect(distributionSkipNote("smart", null)).toBeUndefined();
  });
});
