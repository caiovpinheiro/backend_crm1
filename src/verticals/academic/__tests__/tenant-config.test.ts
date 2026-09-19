/**
 * R1 — config de tenant vem da organização, não de env/código.
 *
 * O teste que importa é o de duas orgs no MESMO processo: era exatamente
 * isso que a constante de módulo (e a variável de ambiente que a
 * substituiu) impedia — a primeira org a carregar congelava o nome da
 * instituição para todas as outras.
 */

import { describe, expect, it, beforeEach } from "vitest";

import { runWithContext } from "@/lib/request-context";
import {
  academicAtendimentoRules,
  formatPoloAddressesHint,
  officialStudentPortalUrl,
} from "@/verticals/academic/atendimento-prompt";
import {
  academicTenantConfig,
  clearAcademicTenantConfigCache,
  primeAcademicTenantConfig,
} from "@/verticals/academic/tenant-config";

const ORG_A = "org_a";
const ORG_B = "org_b";

function asOrg<T>(orgId: string, fn: () => T): T {
  return runWithContext(
    { organizationId: orgId, userId: "u1", isSuperAdmin: false },
    fn,
  ) as T;
}

describe("R1 config de tenant do pack acadêmico", () => {
  beforeEach(() => {
    clearAcademicTenantConfigCache();
  });

  it("gera prompts diferentes para duas orgs no mesmo processo", () => {
    primeAcademicTenantConfig(ORG_A, {
      institutionName: "Faculdade Alfa",
      portalUrl: "https://portal.alfa.example/",
    });
    primeAcademicTenantConfig(ORG_B, {
      institutionName: "Instituto Beta",
      portalUrl: "https://aluno.beta.example/",
    });

    const promptA = asOrg(ORG_A, () => academicAtendimentoRules());
    const promptB = asOrg(ORG_B, () => academicAtendimentoRules());

    expect(promptA).toContain("Faculdade Alfa");
    expect(promptA).toContain("https://portal.alfa.example/");
    expect(promptA).not.toContain("Instituto Beta");

    expect(promptB).toContain("Instituto Beta");
    expect(promptB).toContain("https://aluno.beta.example/");
    expect(promptB).not.toContain("Faculdade Alfa");

    expect(promptA).not.toEqual(promptB);
  });

  it("org sem config: trechos ficam vazios em vez de cair em default de tenant", () => {
    const cfg = asOrg("org_sem_config", () => academicTenantConfig());
    expect(cfg.institutionName).toBe("");
    expect(cfg.poloList).toBe("");
    expect(asOrg("org_sem_config", () => officialStudentPortalUrl())).toBe("");
  });

  it("omite o bloco de polos quando a org não configurou a lista", () => {
    primeAcademicTenantConfig(ORG_A, { institutionName: "Faculdade Alfa" });
    expect(
      asOrg(ORG_A, () => formatPoloAddressesHint("qual o endereço do polo?")),
    ).toBe("");

    primeAcademicTenantConfig(ORG_B, {
      institutionName: "Instituto Beta",
      poloList: "*Polo Centro - Rua Um, 10",
    });
    expect(
      asOrg(ORG_B, () => formatPoloAddressesHint("qual o endereço do polo?")),
    ).toContain("*Polo Centro - Rua Um, 10");
  });

  it("nenhum valor de tenant vem de variável de ambiente", () => {
    process.env.ACADEMIC_INSTITUTION_NAME = "Nome Vindo do Env";
    primeAcademicTenantConfig(ORG_A, { institutionName: "Faculdade Alfa" });
    expect(asOrg(ORG_A, () => academicAtendimentoRules())).not.toContain(
      "Nome Vindo do Env",
    );
    delete process.env.ACADEMIC_INSTITUTION_NAME;
  });
});
