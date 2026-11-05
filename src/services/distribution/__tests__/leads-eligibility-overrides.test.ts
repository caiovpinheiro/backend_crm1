/**
 * Liberação/pausa manual e temporária do modo leads (funções puras):
 * horário de fim, vigência, recorte do sorteio e motivo da coluna "Elegível".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/org-settings", () => ({ getOrgSettingBoolFresh: vi.fn(async () => false) }));

import {
  activeOverridesByUser,
  applyEligibilityOverrides,
  describeEligibility,
  resolveOverrideEndsAt,
} from "@/services/distribution/leads/eligibility-overrides";

/** Instante em America/Sao_Paulo (UTC-3). */
const sp = (iso: string) => new Date(`${iso}-03:00`);
const win = (userId: string, eligible: boolean, from: string, to: string) => ({
  userId,
  eligible,
  startsAt: sp(from),
  endsAt: sp(to),
});

describe("resolveOverrideEndsAt", () => {
  it("17:00 liberando até 22:00 → hoje 22:00", () => {
    expect(resolveOverrideEndsAt("22:00", sp("2026-11-05T17:00:30"))?.toISOString()).toBe(
      sp("2026-11-05T22:00:00").toISOString(),
    );
  });
  it("horário que já passou hoje → amanhã (máx. 24 h)", () => {
    expect(resolveOverrideEndsAt("08:00", sp("2026-11-05T17:00:00"))?.toISOString()).toBe(
      sp("2026-11-06T08:00:00").toISOString(),
    );
    expect(resolveOverrideEndsAt("17:00", sp("2026-11-05T17:00:00"))?.toISOString()).toBe(
      sp("2026-11-06T17:00:00").toISOString(),
    );
  });
  it("inválido → null", () => {
    expect(resolveOverrideEndsAt("25:00", new Date())).toBeNull();
    expect(resolveOverrideEndsAt("", new Date())).toBeNull();
    expect(resolveOverrideEndsAt(undefined, new Date())).toBeNull();
  });
});

describe("activeOverridesByUser", () => {
  it("só vale dentro da janela [início, fim)", () => {
    const rows = [win("ana", true, "2026-11-05T17:00:00", "2026-11-05T22:00:00")];
    expect(activeOverridesByUser(rows, sp("2026-11-05T16:59:00")).size).toBe(0);
    expect(activeOverridesByUser(rows, sp("2026-11-05T17:00:00")).get("ana")?.eligible).toBe(true);
    expect(activeOverridesByUser(rows, sp("2026-11-05T22:00:00")).size).toBe(0);
  });
});

describe("applyEligibilityOverrides", () => {
  const now = sp("2026-11-05T18:00:00");
  const overrides = activeOverridesByUser(
    [
      win("ana", true, "2026-11-05T17:00:00", "2026-11-05T22:00:00"),
      win("bia", false, "2026-11-05T17:30:00", "2026-11-05T19:00:00"),
    ],
    now,
  );
  it("regras ligadas: departamento ativo + liberados − pausados", () => {
    const r = applyEligibilityOverrides({ departmentUserIds: ["bia", "caio"], overrides });
    expect(r.allowUserIds?.sort()).toEqual(["ana", "caio"]);
  });
  it("regras desligadas: sem recorte, só tira os pausados", () => {
    const r = applyEligibilityOverrides({ departmentUserIds: undefined, overrides });
    expect(r.allowUserIds).toBeUndefined();
    expect(r.excludeUserIds).toEqual(["bia"]);
  });
});

describe("describeEligibility", () => {
  const base = { status: "ACTIVE", weight: 3, rulesEnabled: true, departmentActiveNow: false, override: undefined };
  it("motivos", () => {
    expect(describeEligibility({ ...base, status: "INACTIVE" }).reason).toBe("INACTIVE");
    expect(describeEligibility({ ...base, weight: 0 }).reason).toBe("WEIGHT_ZERO");
    expect(describeEligibility(base)).toMatchObject({ eligibleNow: false, reason: "OUT_OF_HOURS" });
    expect(describeEligibility({ ...base, departmentActiveNow: true })).toMatchObject({
      eligibleNow: true,
      reason: "DEPARTMENT_ACTIVE",
    });
    expect(describeEligibility({ ...base, rulesEnabled: false })).toMatchObject({ eligibleNow: true, reason: "RULES_OFF" });
  });
  it("liberação e pausa ganham do horário e aparecem com o fim", () => {
    const lib = describeEligibility({ ...base, override: win("x", true, "2026-11-05T17:00:00", "2026-11-05T22:00:00") });
    expect(lib).toMatchObject({ eligibleNow: true, reason: "OVERRIDE_ELIGIBLE", override: { eligible: true } });
    expect(lib.override?.endsAt).toBe(sp("2026-11-05T22:00:00").toISOString());
    const pau = describeEligibility({
      ...base,
      departmentActiveNow: true,
      override: win("x", false, "2026-11-05T10:00:00", "2026-11-05T11:00:00"),
    });
    expect(pau).toMatchObject({ eligibleNow: false, reason: "OVERRIDE_INELIGIBLE" });
  });
  it("liberado mas inativo continua não elegível", () => {
    expect(
      describeEligibility({ ...base, status: "INACTIVE", override: win("x", true, "2026-11-05T17:00:00", "2026-11-05T22:00:00") })
        .eligibleNow,
    ).toBe(false);
  });
});
