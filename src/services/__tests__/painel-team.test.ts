import { describe, expect, it } from "vitest";

import { DEFAULT_BUSINESS_HOURS } from "@/services/painel-period";
import {
  NONE_DEPT_KEY,
  buildDeptHour,
  buildRanking,
  buildTransferSet,
  parseTeamSections,
} from "@/services/painel-team";

describe("buildDeptHour", () => {
  it("monta a matriz 24h por departamento, com totais e máximo", () => {
    const out = buildDeptHour([
      { deptId: "d1", deptName: "SAC", h: 9, c: BigInt(4) },
      { deptId: "d1", deptName: "SAC", h: 10, c: 2 },
      { deptId: "d2", deptName: "Retenção", h: 9, c: 7 },
      { deptId: null, deptName: null, h: 23, c: 1 },
    ]);
    expect(out.total).toBe(14);
    expect(out.max).toBe(7);
    expect(out.totals[9]).toBe(11);
    expect(out.rows.map((r) => r.key)).toEqual(["d2", "d1", NONE_DEPT_KEY]);
    expect(out.rows[1].hours[10]).toBe(2);
    expect(out.rows[1].total).toBe(6);
    expect(out.rows[2].label).toBe("Sem departamento");
    expect(out.empty).toBe(false);
  });

  it("ignora horas inválidas e fica vazio sem dados", () => {
    const out = buildDeptHour([{ deptId: "d1", deptName: "SAC", h: 24, c: 3 }]);
    expect(out.empty).toBe(true);
    expect(out.rows).toEqual([]);
  });
});

describe("buildRanking", () => {
  it("usa a carga distinta já contada no banco e calcula tempo médio por atendente", () => {
    const t = (min: number) => new Date(Date.UTC(2026, 9, 5, 12, min));
    const rows = buildRanking({
      load: [
        { userId: "a", attended: BigInt(2) },
        { userId: "b", attended: 1 },
      ],
      closed: [
        { userId: "a", createdAt: t(0), endedAt: t(10) },
        { userId: "a", createdAt: t(0), endedAt: t(30) },
        { userId: "c", createdAt: t(0), endedAt: t(5) },
      ],
      names: new Map([
        ["a", "Ana"],
        ["b", "Bruno"],
      ]),
      clock: "elapsed",
      hours: DEFAULT_BUSINESS_HOURS,
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toMatchObject({ attended: 2, finished: 2, serviceSample: 2 });
    expect(rows[0].serviceMeanMs).toBe(20 * 60_000);
    expect(rows[1].serviceMeanMs).toBeNull();
    expect(rows[2]).toMatchObject({ name: "Sem nome", attended: 0, finished: 1 });
  });
});

describe("parseTeamSections", () => {
  it("aceita só seções conhecidas", () => {
    expect(parseTeamSections("ranking,xyz")).toEqual(["ranking"]);
    expect(parseTeamSections(null)).toEqual(["deptHour", "ranking", "transfers"]);
  });
});

describe("buildTransferSet", () => {
  it("ordena rotas, ignora auto-transferência e rotula vazios", () => {
    const out = buildTransferSet(
      [
        { fromId: "a", fromName: "Ana", toId: "b", toName: "Bruno", c: BigInt(3), convs: 2, totalConvs: 5 },
        { fromId: null, fromName: null, toId: "d1", toName: "SAC", c: 5, convs: 5, totalConvs: 5 },
        { fromId: "x", fromName: "X", toId: "x", toName: "X", c: 9, convs: 9, totalConvs: 5 },
      ],
      "Sem departamento",
    );
    expect(out.total).toBe(8);
    expect(out.conversations).toBe(5);
    expect(out.flows.map((f) => `${f.from.name}>${f.to.name}`)).toEqual([
      "Sem departamento>SAC",
      "Ana>Bruno",
    ]);
    expect(out.flows[0].from.id).toBe("__none__");
  });

  it("fica vazio sem rotas", () => {
    expect(buildTransferSet([], "-").empty).toBe(true);
  });
});
