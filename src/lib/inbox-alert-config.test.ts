process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_ALERT_CONFIG,
  parseInboxAlertConfig,
  resolveInboxAlertConfig,
  type InboxAlertConfig,
  type OrgInboxAlertConfigs,
} from "@/lib/inbox-alert-config";
import { inboxAlertKindFor, inboxPushCandidates } from "@/lib/inbox-alert-push-targets";

const off = { sound: false, toast: false, native: false, tab: false };
const cfg = (over: Partial<InboxAlertConfig>): InboxAlertConfig => ({
  mine: off,
  queue: off,
  others: off,
  ...over,
});
const configs = (
  departments: Record<string, InboxAlertConfig> = {},
  users: Record<string, InboxAlertConfig> = {},
): OrgInboxAlertConfigs => ({
  departments: new Map(Object.entries(departments)),
  users: new Map(Object.entries(users)),
});

describe("resolveInboxAlertConfig", () => {
  it("sem config → padrão (comportamento anterior)", () => {
    expect(resolveInboxAlertConfig(configs(), "u1", ["d1"])).toEqual(DEFAULT_INBOX_ALERT_CONFIG);
  });

  it("config do usuário ganha dos departamentos", () => {
    const own = cfg({ mine: { ...off, toast: true } });
    const dept = cfg({ mine: { sound: true, toast: true, native: true, tab: true } });
    expect(resolveInboxAlertConfig(configs({ d1: dept }, { u1: own }), "u1", ["d1"])).toEqual(own);
  });

  it("vários departamentos → o mais permissivo (OR)", () => {
    const a = cfg({ mine: { ...off, sound: true } });
    const b = cfg({ mine: { ...off, native: true }, queue: { ...off, toast: true } });
    const eff = resolveInboxAlertConfig(configs({ a, b }), "u1", ["a", "b"]);
    expect(eff.mine).toEqual({ sound: true, toast: false, native: true, tab: false });
    expect(eff.queue.toast).toBe(true);
  });

  it("departamento sem config não entra na soma", () => {
    const a = cfg({ mine: { ...off, toast: true } });
    expect(resolveInboxAlertConfig(configs({ a }), "u1", ["a", "sem_config"])).toEqual(a);
  });

  it("JSON inválido é ignorado", () => {
    expect(parseInboxAlertConfig("{")).toBeNull();
    expect(parseInboxAlertConfig(JSON.stringify({ mine: off }))).toBeNull();
  });
});

describe("push: tipo e candidatos", () => {
  const conv = (over: Partial<Parameters<typeof inboxAlertKindFor>[0]> = {}) => ({
    assignedToId: null,
    assignedToType: null,
    departmentId: "d1",
    ...over,
  });

  it("classifica mine / queue / others", () => {
    expect(inboxAlertKindFor(conv({ assignedToId: "u1" }), "u1", [])).toBe("mine");
    expect(inboxAlertKindFor(conv(), "u1", ["d1"])).toBe("queue");
    expect(inboxAlertKindFor(conv(), "u1", ["d2"])).toBe("others");
    expect(inboxAlertKindFor(conv({ assignedToId: "u2" }), "u1", ["d1"])).toBe("others");
    expect(
      inboxAlertKindFor(conv({ assignedToId: "ia", assignedToType: "AI" }), "u1", ["d1"]),
    ).toBe("others");
  });

  it("padrão: push só para o responsável", () => {
    const out = inboxPushCandidates({
      conversation: conv({ assignedToId: "u1" }),
      userIds: ["u1", "u2", "admin"],
      departmentsByUser: new Map([["u2", ["d1"]]]),
      configs: configs(),
    });
    expect(out).toEqual([{ userId: "u1", needsVisibility: false }]);
  });

  it("fila com native ligado no departamento → membros, com gate", () => {
    const d1 = cfg({ queue: { ...off, native: true } });
    const out = inboxPushCandidates({
      conversation: conv(),
      userIds: ["u1", "u2"],
      departmentsByUser: new Map([["u1", ["d1"]]]),
      configs: configs({ d1 }),
    });
    expect(out).toEqual([{ userId: "u1", needsVisibility: true }]);
  });

  it("outras visíveis por usuário", () => {
    const sup = cfg({ others: { ...off, native: true } });
    const out = inboxPushCandidates({
      conversation: conv({ assignedToId: "u2" }),
      userIds: ["u2", "sup"],
      departmentsByUser: new Map(),
      configs: configs({}, { sup }),
    });
    expect(out).toEqual([
      { userId: "u2", needsVisibility: false },
      { userId: "sup", needsVisibility: true },
    ]);
  });
});
