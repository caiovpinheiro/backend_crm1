import { describe, expect, it } from "vitest";
import {
  pickPreviousAttendance,
  readRestoreAttendanceConfig,
  resolveRestoreTarget,
  summarizeRestoreAttendance,
  type AttendanceEvent,
} from "./restore-attendance";

const t0 = new Date("2026-11-09T12:00:00Z").getTime();
const at = (sec: number) => new Date(t0 + sec * 1000);

const assignee = (sec: number, from: string | null, to: string | null): AttendanceEvent => ({
  type: "ASSIGNEE_CHANGED",
  occurredAt: at(sec),
  meta: { fromUserId: from, toUserId: to },
});
const distributed = (sec: number, to: string): AttendanceEvent => ({
  type: "LEAD_DISTRIBUTED",
  occurredAt: at(sec),
  meta: { selectedUserId: to },
});
const dept = (sec: number, from: string | null, to: string | null, extra: Record<string, unknown> = {}): AttendanceEvent => ({
  type: "CONVERSATION_DEPARTMENT_CHANGED",
  occurredAt: at(sec),
  meta: { fromDepartmentId: from, toDepartmentId: to, ...extra },
});

describe("pickPreviousAttendance", () => {
  it("usa fromAssigneeId gravado na transferência", () => {
    const r = pickPreviousAttendance(
      [assignee(0, null, "A"), dept(60, "vendas", "fin", { fromAssigneeId: "A" }), distributed(61, "B")],
      { endedDepartmentId: "fin" },
    );
    expect(r).toEqual({ userId: "A", departmentId: "vendas", agentSource: "transfer" });
  });

  it("fromAssigneeId null = antes não havia responsável", () => {
    const r = pickPreviousAttendance([dept(60, null, "fin", { fromAssigneeId: null })]);
    expect(r.userId).toBeNull();
    expect(r.departmentId).toBeNull();
  });

  it("evento antigo: última atribuição antes da transferência", () => {
    const r = pickPreviousAttendance(
      [assignee(0, null, "A"), dept(60, "vendas", "fin"), distributed(61, "B"), assignee(300, "B", null)],
      { endedDepartmentId: "fin" },
    );
    expect(r).toMatchObject({ userId: "A", departmentId: "vendas", agentSource: "before_transfer" });
  });

  it("agente + depto no mesmo pedido: a troca de agente logo antes conta como parte da transferência", () => {
    const r = pickPreviousAttendance(
      [assignee(0, null, "A"), assignee(59.9, "A", "B"), dept(60, "vendas", "fin")],
      { endedDepartmentId: "fin" },
    );
    expect(r.userId).toBe("A");
  });

  it("sem atribuição antes: fromUserId da primeira troca depois", () => {
    const r = pickPreviousAttendance([dept(60, "vendas", "fin"), assignee(61, "A", "B")]);
    expect(r).toMatchObject({ userId: "A", agentSource: "after_transfer" });
  });

  it("prefere a transferência para o departamento que encerrou", () => {
    const r = pickPreviousAttendance(
      [
        dept(10, "vendas", "fin", { fromAssigneeId: "A" }),
        dept(20, "fin", "suporte", { fromAssigneeId: "B" }),
      ],
      { endedDepartmentId: "fin" },
    );
    expect(r).toMatchObject({ userId: "A", departmentId: "vendas" });
  });

  it("ignora troca para 'sem departamento' como âncora", () => {
    const r = pickPreviousAttendance([
      dept(10, "vendas", "fin", { fromAssigneeId: "A" }),
      dept(20, "fin", null, { fromAssigneeId: "B" }),
    ]);
    expect(r).toMatchObject({ userId: "A", departmentId: "vendas" });
  });

  it("sem transferência registrada: responsável anterior ao último", () => {
    const r = pickPreviousAttendance([assignee(0, null, "A"), assignee(10, "A", "B"), assignee(20, "B", null)]);
    expect(r).toEqual({ userId: "A", departmentId: undefined, agentSource: "holders" });
  });

  it("sem histórico: não encontrado", () => {
    expect(pickPreviousAttendance([])).toEqual({ userId: undefined, departmentId: undefined, agentSource: "none" });
    expect(pickPreviousAttendance([assignee(0, null, "A")]).userId).toBeUndefined();
  });
});

describe("resolveRestoreTarget", () => {
  it("manter não mexe", () => {
    expect(resolveRestoreTarget("keep", "A", "clear")).toEqual({ change: false });
  });
  it("remover limpa", () => {
    expect(resolveRestoreTarget("clear", "A", "keep")).toEqual({ change: true, value: null });
  });
  it("anterior encontrado (inclusive 'sem')", () => {
    expect(resolveRestoreTarget("previous", "A", "keep")).toEqual({ change: true, value: "A" });
    expect(resolveRestoreTarget("previous", null, "keep")).toEqual({ change: true, value: null });
  });
  it("anterior não encontrado segue o fallback", () => {
    expect(resolveRestoreTarget("previous", undefined, "keep")).toEqual({ change: false });
    expect(resolveRestoreTarget("previous", undefined, "clear")).toEqual({ change: true, value: null });
  });
});

describe("readRestoreAttendanceConfig / summarize", () => {
  it("padrões", () => {
    expect(readRestoreAttendanceConfig({})).toEqual({
      agentMode: "previous",
      departmentMode: "previous",
      notFound: "keep",
      reopen: false,
    });
  });
  it("lê valores do editor (select grava string)", () => {
    expect(
      readRestoreAttendanceConfig({ agentMode: "clear", departmentMode: "keep", notFound: "clear", reopen: "yes" }),
    ).toEqual({ agentMode: "clear", departmentMode: "keep", notFound: "clear", reopen: true });
  });
  it("resumo", () => {
    expect(summarizeRestoreAttendance({ agentMode: "previous", departmentMode: "clear", reopen: true })).toBe(
      "Agente: anterior · Depto: remover · reabre",
    );
  });
});
