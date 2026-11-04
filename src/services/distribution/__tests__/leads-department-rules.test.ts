/**
 * Regras de horário por departamento do modo leads (funções puras):
 * janela no mesmo dia, intervalo que cruza a meia-noite, dias da semana,
 * sobreposição de departamentos, próxima transição e validação do corpo.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBoolFresh: vi.fn(async () => false),
}));

import {
  eligibleUserIdsByDepartmentRulesTx,
  isAnyRuleActiveAt,
  isRuleActiveAt,
  localClock,
  nextTransition,
  parseClockMinute,
  parseLeadsDepartmentRuleInput,
} from "@/services/distribution/leads/department-rules";

/** Instante em America/Sao_Paulo (UTC-3, sem horário de verão em 2026). */
function sp(iso: string): Date {
  return new Date(`${iso}-03:00`);
}
const h = (hh: number, mm = 0) => hh * 60 + mm;
const ALL = [0, 1, 2, 3, 4, 5, 6];
const DIA = { startMinute: h(9), endMinute: h(18), weekdays: ALL, enabled: true };
const NOITE = { startMinute: h(15), endMinute: h(22), weekdays: ALL, enabled: true };

describe("localClock", () => {
  it("converte para o fuso de São Paulo", () => {
    // 2026-11-04 é quarta-feira. 02:30Z = 23:30 de terça em SP.
    expect(localClock(new Date("2026-11-04T02:30:00Z"))).toEqual({ weekday: 2, minute: h(23, 30) });
    expect(localClock(sp("2026-11-04T09:00:00"))).toEqual({ weekday: 3, minute: h(9) });
  });
});

describe("isRuleActiveAt", () => {
  it("janela no mesmo dia: início inclusivo, fim exclusivo", () => {
    expect(isRuleActiveAt(DIA, { weekday: 3, minute: h(8, 59) })).toBe(false);
    expect(isRuleActiveAt(DIA, { weekday: 3, minute: h(9) })).toBe(true);
    expect(isRuleActiveAt(DIA, { weekday: 3, minute: h(17, 59) })).toBe(true);
    expect(isRuleActiveAt(DIA, { weekday: 3, minute: h(18) })).toBe(false);
  });

  it("só nos dias da semana escolhidos", () => {
    const util = { ...DIA, weekdays: [1, 2, 3, 4, 5] };
    expect(isRuleActiveAt(util, { weekday: 6, minute: h(10) })).toBe(false);
    expect(isRuleActiveAt(util, { weekday: 1, minute: h(10) })).toBe(true);
  });

  it("regra desabilitada ou com início = fim nunca ativa", () => {
    expect(isRuleActiveAt({ ...DIA, enabled: false }, { weekday: 3, minute: h(10) })).toBe(false);
    expect(
      isRuleActiveAt({ ...DIA, endMinute: DIA.startMinute }, { weekday: 3, minute: h(9) }),
    ).toBe(false);
  });

  it("cruza a meia-noite: o dia da semana é o do início", () => {
    const madrugada = { startMinute: h(22), endMinute: h(2), weekdays: [1], enabled: true }; // seg 22:00–02:00
    expect(isRuleActiveAt(madrugada, { weekday: 1, minute: h(21, 59) })).toBe(false);
    expect(isRuleActiveAt(madrugada, { weekday: 1, minute: h(22) })).toBe(true);
    expect(isRuleActiveAt(madrugada, { weekday: 1, minute: h(23, 59) })).toBe(true);
    // Terça 01:00 ainda é a janela que começou segunda.
    expect(isRuleActiveAt(madrugada, { weekday: 2, minute: h(1) })).toBe(true);
    expect(isRuleActiveAt(madrugada, { weekday: 2, minute: h(2) })).toBe(false);
    // Terça 22:30 não: a regra é só de segunda.
    expect(isRuleActiveAt(madrugada, { weekday: 2, minute: h(22, 30) })).toBe(false);
    // Segunda 01:00 é a madrugada de domingo, fora.
    expect(isRuleActiveAt(madrugada, { weekday: 1, minute: h(1) })).toBe(false);
  });
});

describe("sobreposição DIA / NOITE", () => {
  it("das 15h às 18h os dois departamentos estão ativos", () => {
    const c = { weekday: 3, minute: h(16) };
    expect(isRuleActiveAt(DIA, c)).toBe(true);
    expect(isRuleActiveAt(NOITE, c)).toBe(true);
    expect(isRuleActiveAt(DIA, { weekday: 3, minute: h(20) })).toBe(false);
    expect(isRuleActiveAt(NOITE, { weekday: 3, minute: h(20) })).toBe(true);
    expect(isAnyRuleActiveAt([DIA, NOITE], { weekday: 3, minute: h(23) })).toBe(false);
  });
});

describe("nextTransition", () => {
  it("fora do horário: próxima ativação; dentro: próximo encerramento", () => {
    const antes = nextTransition([DIA], sp("2026-11-04T08:00:00"));
    expect(antes?.becomesActive).toBe(true);
    expect(antes?.at.toISOString()).toBe(sp("2026-11-04T09:00:00").toISOString());
    const dentro = nextTransition([DIA], sp("2026-11-04T10:00:00"));
    expect(dentro?.becomesActive).toBe(false);
    expect(dentro?.at.toISOString()).toBe(sp("2026-11-04T18:00:00").toISOString());
  });

  it("duas regras do mesmo departamento viram uma só janela contínua", () => {
    const t = nextTransition([DIA, NOITE], sp("2026-11-04T17:00:00"));
    expect(t?.becomesActive).toBe(false);
    expect(t?.at.toISOString()).toBe(sp("2026-11-04T22:00:00").toISOString());
  });

  it("sem regra habilitada ou 24x7 não há transição", () => {
    expect(nextTransition([], sp("2026-11-04T10:00:00"))).toBeNull();
    expect(nextTransition([{ ...DIA, enabled: false }], sp("2026-11-04T10:00:00"))).toBeNull();
    expect(
      nextTransition(
        [{ startMinute: 0, endMinute: 1439, weekdays: ALL, enabled: true }],
        sp("2026-11-04T10:00:00"),
      )?.at.toISOString(),
    ).toBe(sp("2026-11-04T23:59:00").toISOString());
  });

  it("regra só de segunda, consultada na quinta: ativa na próxima segunda", () => {
    const t = nextTransition([{ ...DIA, weekdays: [1] }], sp("2026-11-05T10:00:00"));
    expect(t?.becomesActive).toBe(true);
    expect(t?.at.toISOString()).toBe(sp("2026-11-09T09:00:00").toISOString());
  });
});

describe("parseLeadsDepartmentRuleInput", () => {
  it("aceita corpo completo e normaliza os dias", () => {
    const r = parseLeadsDepartmentRuleInput({
      departmentId: " d1 ",
      startMinute: 540,
      endMinute: 1080,
      weekdays: [5, 1, 1, 3],
    });
    expect(r).toEqual({
      ok: true,
      value: { departmentId: "d1", startMinute: 540, endMinute: 1080, weekdays: [1, 3, 5], enabled: true },
    });
  });

  it("recusa minuto fora da faixa, início = fim, dia inválido e sem dias", () => {
    const base = { departmentId: "d1", startMinute: 540, endMinute: 1080, weekdays: [1] };
    expect(parseLeadsDepartmentRuleInput({ ...base, startMinute: 1440 }).ok).toBe(false);
    expect(parseLeadsDepartmentRuleInput({ ...base, endMinute: -1 }).ok).toBe(false);
    expect(parseLeadsDepartmentRuleInput({ ...base, endMinute: 540 }).ok).toBe(false);
    expect(parseLeadsDepartmentRuleInput({ ...base, weekdays: [7] }).ok).toBe(false);
    expect(parseLeadsDepartmentRuleInput({ ...base, weekdays: [] }).ok).toBe(false);
    expect(parseLeadsDepartmentRuleInput({ ...base, departmentId: "" }).ok).toBe(false);
  });

  it("parcial aceita só os campos enviados", () => {
    expect(parseLeadsDepartmentRuleInput({ enabled: false }, { partial: true })).toEqual({
      ok: true,
      value: { enabled: false },
    });
    expect(parseLeadsDepartmentRuleInput({ enabled: "x" }, { partial: true }).ok).toBe(false);
  });

  it("parseClockMinute lê HH:MM", () => {
    expect(parseClockMinute("09:05")).toBe(545);
    expect(parseClockMinute("24:00")).toBeNull();
    expect(parseClockMinute(600)).toBe(600);
  });
});

describe("eligibleUserIdsByDepartmentRulesTx", () => {
  function fakeTx(
    rules: { departmentId: string; startMinute: number; endMinute: number; weekdays: number[]; enabled: boolean }[],
    members: { departmentId: string; userId: string }[],
  ) {
    return {
      distributionLeadsDepartmentRule: {
        findMany: vi.fn(async ({ where }: { where: { enabled?: boolean } }) =>
          rules.filter((r) => (where.enabled === undefined ? true : r.enabled === where.enabled)),
        ),
      },
      departmentMember: {
        findMany: vi.fn(async ({ where }: { where: { departmentId: { in: string[] } } }) =>
          members.filter((m) => where.departmentId.in.includes(m.departmentId)),
        ),
      },
    };
  }
  const members = [
    { departmentId: "dia", userId: "ana" },
    { departmentId: "dia", userId: "bia" },
    { departmentId: "noite", userId: "bia" }, // Bia está nos dois
    { departmentId: "noite", userId: "caio" },
    { departmentId: "tres", userId: "dani" }, // departamento sem regra
  ];
  const rules = [
    { departmentId: "dia", ...DIA },
    { departmentId: "noite", ...NOITE },
  ];

  it("só DIA ativo: Ana e Bia; sem Dani (departamento sem regra)", async () => {
    const ids = await eligibleUserIdsByDepartmentRulesTx(fakeTx(rules, members) as never, "org1", sp("2026-11-04T10:00:00"));
    expect(ids.sort()).toEqual(["ana", "bia"]);
  });

  it("sobreposição 15h–18h: união dos dois, Bia uma vez só", async () => {
    const ids = await eligibleUserIdsByDepartmentRulesTx(fakeTx(rules, members) as never, "org1", sp("2026-11-04T16:00:00"));
    expect(ids.sort()).toEqual(["ana", "bia", "caio"]);
  });

  it("nenhuma regra ativa (23h) ou regra desabilitada: ninguém", async () => {
    expect(
      await eligibleUserIdsByDepartmentRulesTx(fakeTx(rules, members) as never, "org1", sp("2026-11-04T23:00:00")),
    ).toEqual([]);
    const off = rules.map((r) => ({ ...r, enabled: false }));
    expect(
      await eligibleUserIdsByDepartmentRulesTx(fakeTx(off, members) as never, "org1", sp("2026-11-04T10:00:00")),
    ).toEqual([]);
  });
});
