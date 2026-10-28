/**
 * Peso por departamento (`DepartmentMember.distributionWeight`).
 *
 * Caso do pedido: consultor em Acolhimento e Atendimento, peso 3 no
 * Acolhimento e 1 no Atendimento. No sorteio de um lead do Acolhimento ele
 * tem 3 bilhetes contra 1 de cada colega; no Atendimento, 1 como todo mundo.
 * Campo vazio = peso geral (`volume`) — ninguém muda até alguém preencher.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ACOLHIMENTO = "dept_acolhimento";
const ATENDIMENTO = "dept_atendimento";

interface MemberRow {
  userId: string;
  departmentId: string;
  distributionWeight: number | null;
}

let members: MemberRow[] = [];
let volumes: Record<string, number> = {};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => [
        { id: "X", name: "X", email: null, avatarUrl: null, role: "MEMBER" },
        { id: "Y", name: "Y", email: null, avatarUrl: null, role: "MEMBER" },
      ]),
    },
    departmentMember: {
      findMany: vi.fn(
        async (args: {
          where: { departmentId?: { in: string[] } };
          select: Record<string, unknown>;
        }) => {
          const inScope = args.where.departmentId?.in;
          const rows = inScope
            ? members.filter((m) => inScope.includes(m.departmentId))
            : members;
          return rows.map((m) => ({
            userId: m.userId,
            distributionWeight: m.distributionWeight,
            department: { id: m.departmentId, name: m.departmentId },
          }));
        },
      ),
    },
    distributionResponsible: {
      findMany: vi.fn(async () =>
        Object.entries(volumes).map(([userId, volume]) => ({
          userId,
          participates: true,
          visibleInCoverage: true,
          queueLimit: 10,
          volume,
          type: null,
          paused: false,
          preLunchStopMinutes: 0,
          lastExecutionAt: null,
        })),
      ),
    },
    agentStatus: {
      findMany: vi.fn(async () => [
        { userId: "X", status: "ONLINE" },
        { userId: "Y", status: "ONLINE" },
      ]),
    },
    agentSchedule: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/request-context")>()),
  getOrgIdOrThrow: () => "org_teste",
}));

vi.mock("@/services/system-presence", () => ({
  getSystemPresenceMap: async () => new Map(),
}));

vi.mock("../queue", () => ({
  getQueueCounts: async () => new Map<string, number>(),
}));

import { selectResponsible } from "../engine";
import {
  getDistributionResponsibles,
  resolveEffectiveWeight,
  type DistributionResponsibleView,
} from "../responsibles";

beforeEach(() => {
  members = [
    { userId: "X", departmentId: ACOLHIMENTO, distributionWeight: 3 },
    { userId: "X", departmentId: ATENDIMENTO, distributionWeight: null },
    { userId: "Y", departmentId: ACOLHIMENTO, distributionWeight: null },
    { userId: "Y", departmentId: ATENDIMENTO, distributionWeight: null },
  ];
  volumes = { X: 1, Y: 1 };
});

describe("resolveEffectiveWeight", () => {
  it("sem escopo de departamento usa o peso geral", () => {
    expect(resolveEffectiveWeight(2, null)).toBe(2);
    expect(resolveEffectiveWeight(2, [])).toBe(2);
  });

  it("peso do departamento vazio = peso geral", () => {
    expect(resolveEffectiveWeight(4, [{ distributionWeight: null }])).toBe(4);
  });

  it("peso do departamento substitui o geral (para mais ou para menos)", () => {
    expect(resolveEffectiveWeight(1, [{ distributionWeight: 3 }])).toBe(3);
    expect(resolveEffectiveWeight(5, [{ distributionWeight: 1 }])).toBe(1);
  });

  it("pool com vários departamentos: fica o maior, sem somar", () => {
    expect(
      resolveEffectiveWeight(1, [
        { distributionWeight: 3 },
        { distributionWeight: null },
      ]),
    ).toBe(3);
  });
});

describe("getDistributionResponsibles com peso por departamento", () => {
  function byId(list: DistributionResponsibleView[], id: string) {
    return list.find((r) => r.userId === id)!;
  }

  it("lead do Acolhimento: X vale 3, Y vale 1", async () => {
    const list = await getDistributionResponsibles({ departmentId: ACOLHIMENTO });
    expect(byId(list, "X").effectiveWeight).toBe(3);
    expect(byId(list, "Y").effectiveWeight).toBe(1);
  });

  it("lead do Atendimento: X vale 1 como os colegas", async () => {
    const list = await getDistributionResponsibles({ departmentId: ATENDIMENTO });
    expect(byId(list, "X").effectiveWeight).toBe(1);
    expect(byId(list, "Y").effectiveWeight).toBe(1);
  });

  it("sem departamento no lead: vale o peso geral", async () => {
    volumes = { X: 2, Y: 1 };
    const list = await getDistributionResponsibles();
    expect(byId(list, "X").effectiveWeight).toBe(2);
    expect(byId(list, "Y").effectiveWeight).toBe(1);
  });

  it("sem nenhum peso por departamento, nada muda (todos = volume)", async () => {
    members = members.map((m) => ({ ...m, distributionWeight: null }));
    const list = await getDistributionResponsibles({ departmentId: ACOLHIMENTO });
    expect(list.map((r) => r.effectiveWeight)).toEqual([1, 1]);
  });

  it("devolve o peso de cada departamento para a tela", async () => {
    const list = await getDistributionResponsibles();
    expect(byId(list, "X").departments).toEqual([
      { id: ACOLHIMENTO, name: ACOLHIMENTO, weight: 3 },
      { id: ATENDIMENTO, name: ATENDIMENTO, weight: null },
    ]);
  });

  it("sorteio do Acolhimento: X fica com 3 dos 4 bilhetes", async () => {
    const list = await getDistributionResponsibles({ departmentId: ACOLHIMENTO });
    const pot = list.filter((r) => r.eligible);
    expect(pot.map((r) => r.userId)).toEqual(["X", "Y"]);
    expect(selectResponsible(pot, () => 0).userId).toBe("X");
    expect(selectResponsible(pot, () => 2.999 / 4).userId).toBe("X");
    expect(selectResponsible(pot, () => 3 / 4).userId).toBe("Y");
  });
});
