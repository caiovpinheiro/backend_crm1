/**
 * Passo "Executar distribuição" com modo explícito é independente da aba
 * Distribuição: o comercial usa Por Leads (Inteligente desligado) e o passo
 * do Acadêmico usa Inteligente. O interruptor continua sendo o freio do
 * modo ATIVO da org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingOrDefault: async (key: string, def: string) => settings.get(key) ?? def,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_teste" }));

const { orgSwitchAppliesTo } = await import("../mode");

describe("orgSwitchAppliesTo", () => {
  beforeEach(() => settings.clear());

  it("sem modo explícito no passo, o interruptor sempre vale", async () => {
    settings.set("distribution.mode", "leads");
    expect(await orgSwitchAppliesTo("smart", false)).toBe(true);
    expect(await orgSwitchAppliesTo("leads", false)).toBe(true);
  });

  it("org em Por Leads: passo Inteligente explícito ignora o interruptor do Inteligente", async () => {
    settings.set("distribution.mode", "leads");
    expect(await orgSwitchAppliesTo("smart", true)).toBe(false);
  });

  it("org em Por Leads: passo Por Leads explícito respeita o freio do Por Leads", async () => {
    settings.set("distribution.mode", "leads");
    expect(await orgSwitchAppliesTo("leads", true)).toBe(true);
  });

  it("org em Inteligente: passo Por Leads explícito ignora o interruptor do Por Leads", async () => {
    settings.set("distribution.mode", "smart");
    expect(await orgSwitchAppliesTo("leads", true)).toBe(false);
    expect(await orgSwitchAppliesTo("smart", true)).toBe(true);
  });
});
