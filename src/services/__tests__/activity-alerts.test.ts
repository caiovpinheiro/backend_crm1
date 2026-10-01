/**
 * Testes focados de activity-alerts (elegibilidade + claim + paginação).
 * Funções puras + mocks leves — sem DB real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/web-push", () => ({
  sendPushToUser: vi.fn(async () => 0),
}));

const { deliveryStore, deliveryPrisma, actionStore, actionPrisma } = vi.hoisted(() => {
  const deliveryStore: {
    activities: Array<Record<string, unknown>>;
    states: Array<Record<string, unknown>>;
    deptMembers: Array<{ userId: string; organizationId: string; departmentId: string }>;
    /** Simula corrida: próximo updateMany elegível retorna count 0. */
    forceUpdateManyLose: boolean;
    /** Simula P2002 no próximo create. */
    forceCreateP2002: boolean;
  } = {
    activities: [],
    states: [],
    deptMembers: [],
    forceUpdateManyLose: false,
    forceCreateP2002: false,
  };

  function matchesClaimWhere(
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean {
    if (where.id != null && row.id !== where.id) return false;
    if (where.scheduledFor != null) {
      const a = where.scheduledFor as Date;
      const b = row.scheduledFor as Date;
      if (a.getTime() !== b.getTime()) return false;
    }
    if ("dismissedAt" in where && where.dismissedAt === null && row.dismissedAt != null) {
      return false;
    }
    if ("preDueShownAt" in where && where.preDueShownAt === null && row.preDueShownAt != null) {
      return false;
    }
    if ("dueShownAt" in where && where.dueShownAt === null && row.dueShownAt != null) {
      return false;
    }
    if (Array.isArray(where.OR)) {
      const nowOr = where.OR as Array<Record<string, unknown>>;
      const snoozeOk = nowOr.some((clause) => {
        if ("snoozedUntil" in clause && clause.snoozedUntil === null) {
          return row.snoozedUntil == null;
        }
        if (
          clause.snoozedUntil &&
          typeof clause.snoozedUntil === "object" &&
          "lte" in (clause.snoozedUntil as object)
        ) {
          const lte = (clause.snoozedUntil as { lte: Date }).lte;
          return row.snoozedUntil != null && (row.snoozedUntil as Date).getTime() <= lte.getTime();
        }
        return false;
      });
      if (!snoozeOk) return false;
    }
    return true;
  }

  const deliveryPrisma = {
    activity: {
      findMany: vi.fn(async (args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) => {
        const scheduledAtFilter = args.where.scheduledAt as
          | { not: null; lte?: Date }
          | undefined;
        const horizon = scheduledAtFilter?.lte;

        let rows = deliveryStore.activities.filter((a) => {
          if (a.organizationId !== args.where.organizationId) return false;
          if (a.completed) return false;
          if (a.scheduledAt == null) return false;
          if (horizon && (a.scheduledAt as Date).getTime() > horizon.getTime()) return false;
          return true;
        });

        // Cursor composto via AND[... OR cursor]
        const and = args.where.AND as Array<Record<string, unknown>> | undefined;
        if (and) {
          for (const clause of and) {
            if (Array.isArray(clause.OR) && clause.OR.length === 2) {
              const cursorOr = clause.OR as Array<Record<string, unknown>>;
              const gt = cursorOr[0]?.scheduledAt as { gt?: Date } | undefined;
              const andEq = cursorOr[1]?.AND as Array<Record<string, unknown>> | undefined;
              if (gt?.gt && andEq) {
                const eqAt = andEq[0]?.scheduledAt as Date | undefined;
                const gtId = andEq[1]?.id as { gt?: string } | undefined;
                if (eqAt && gtId?.gt) {
                  rows = rows.filter((a) => {
                    const at = (a.scheduledAt as Date).getTime();
                    const cur = gt.gt!.getTime();
                    if (at > cur) return true;
                    if (at === cur && String(a.id) > gtId.gt!) return true;
                    return false;
                  });
                }
              }
            }
          }
        }

        rows.sort((a, b) => {
          const da = (a.scheduledAt as Date).getTime() - (b.scheduledAt as Date).getTime();
          if (da !== 0) return da;
          return String(a.id).localeCompare(String(b.id));
        });

        return rows.slice(0, args.take ?? rows.length);
      }),
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        return deliveryStore.activities.find((a) => a.id === args.where.id) ?? null;
      }),
    },
    activityAlertState: {
      findMany: vi.fn(async (args: { where: { userId: string; activityId?: { in: string[] } } }) => {
        let rows = deliveryStore.states.filter((s) => s.userId === args.where.userId);
        if (args.where.activityId?.in) {
          const set = new Set(args.where.activityId.in);
          rows = rows.filter((s) => set.has(s.activityId as string));
        }
        return rows;
      }),
      findUnique: vi.fn(async (args: {
        where: { activityId_userId: { activityId: string; userId: string } };
      }) => {
        const key = args.where.activityId_userId;
        return (
          deliveryStore.states.find(
            (s) => s.activityId === key.activityId && s.userId === key.userId,
          ) ?? null
        );
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (deliveryStore.forceCreateP2002) {
          deliveryStore.forceCreateP2002 = false;
          const err = Object.assign(new Error("Unique constraint"), { code: "P2002" });
          throw err;
        }
        const dup = deliveryStore.states.find(
          (s) =>
            s.activityId === args.data.activityId && s.userId === args.data.userId,
        );
        if (dup) {
          const err = Object.assign(new Error("Unique constraint"), { code: "P2002" });
          throw err;
        }
        const row = { id: `st_${deliveryStore.states.length + 1}`, ...args.data };
        deliveryStore.states.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = deliveryStore.states.findIndex((s) => s.id === args.where.id);
        deliveryStore.states[idx] = { ...deliveryStore.states[idx], ...args.data };
        return deliveryStore.states[idx];
      }),
      updateMany: vi.fn(async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (deliveryStore.forceUpdateManyLose) {
          deliveryStore.forceUpdateManyLose = false;
          return { count: 0 };
        }
        const idx = deliveryStore.states.findIndex((s) =>
          matchesClaimWhere(s, args.where),
        );
        if (idx < 0) return { count: 0 };
        deliveryStore.states[idx] = { ...deliveryStore.states[idx], ...args.data };
        return { count: 1 };
      }),
    },
  };

  const actionStore: {
    activities: Array<Record<string, unknown>>;
    states: Array<Record<string, unknown>>;
  } = { activities: [], states: [] };

  const actionPrisma = {
    activity: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        actionStore.activities.find((a) => a.id === args.where.id) ?? null,
      ),
    },
    activityAlertState: {
      findUnique: vi.fn(async (args: {
        where: { activityId_userId: { activityId: string; userId: string } };
      }) => {
        const key = args.where.activityId_userId;
        return (
          actionStore.states.find(
            (s) => s.activityId === key.activityId && s.userId === key.userId,
          ) ?? null
        );
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const idx = actionStore.states.findIndex((s) => s.id === args.where.id);
        actionStore.states[idx] = { ...actionStore.states[idx], ...args.data };
        return actionStore.states[idx];
      }),
    },
  };

  return { deliveryStore, deliveryPrisma, actionStore, actionPrisma };
});

import {
  PRE_DUE_WINDOW_MS,
  SNOOZE_MS,
  applyDismissToState,
  applySnoozeToState,
  buildAlertDto,
  buildOptimisticClaimWhere,
  canSnoozeKind,
  compareAlertCandidates,
  evaluateAlertKind,
  isActivityAlertRecipient,
  isUniqueConstraintError,
  needsAlertStateReset,
  pickNextAlertCandidate,
  resetAlertStateFields,
  type AlertActivitySnapshot,
  type AlertCandidate,
  type AlertStateSnapshot,
} from "@/services/activity-alerts";

const NOW = new Date("2026-08-19T15:00:00.000Z");
const SCHEDULED = new Date("2026-08-19T15:10:00.000Z");
const DUE_AT = new Date("2026-08-19T14:00:00.000Z");

function baseActivity(
  overrides: Partial<AlertActivitySnapshot> = {},
): AlertActivitySnapshot {
  return {
    id: "act_1",
    organizationId: "org_1",
    title: "Ligar cliente",
    type: "CALL",
    completed: false,
    scheduledAt: SCHEDULED,
    userId: "user_1",
    departmentId: null,
    contact: { id: "c1", name: "Ana" },
    deal: null,
    department: null,
    ...overrides,
  };
}

function emptyState(scheduledFor: Date = SCHEDULED): AlertStateSnapshot {
  return resetAlertStateFields(scheduledFor);
}

describe("isActivityAlertRecipient", () => {
  it("responsável individual recebe", () => {
    expect(
      isActivityAlertRecipient({ userId: "user_1", departmentId: null }, "user_1", []),
    ).toBe(true);
  });

  it("membro atual do departamento recebe", () => {
    expect(
      isActivityAlertRecipient(
        { userId: null, departmentId: "dept_1" },
        "user_2",
        ["dept_1"],
      ),
    ).toBe(true);
  });

  it("não-membro / gestor sem atribuição não recebe", () => {
    expect(
      isActivityAlertRecipient(
        { userId: "user_1", departmentId: "dept_1" },
        "manager_1",
        ["dept_other"],
      ),
    ).toBe(false);
  });

  it("union: assignee OU membro", () => {
    expect(
      isActivityAlertRecipient(
        { userId: "user_1", departmentId: "dept_1" },
        "user_1",
        [],
      ),
    ).toBe(true);
    expect(
      isActivityAlertRecipient(
        { userId: "user_1", departmentId: "dept_1" },
        "user_2",
        ["dept_1"],
      ),
    ).toBe(true);
  });
});

describe("evaluateAlertKind", () => {
  it("pré-janela: elegível só em [scheduledAt-15min, scheduledAt)", () => {
    const activity = baseActivity({ scheduledAt: SCHEDULED });
    expect(evaluateAlertKind(activity, null, NOW)).toBe("PRE_DUE");

    const beforeWindow = new Date(SCHEDULED.getTime() - PRE_DUE_WINDOW_MS - 1000);
    expect(evaluateAlertKind(activity, null, beforeWindow)).toBeNull();

    expect(evaluateAlertKind(activity, null, SCHEDULED)).toBe("DUE");
  });

  it("pré perdido não recupera (já shown)", () => {
    const activity = baseActivity({ scheduledAt: SCHEDULED });
    const state: AlertStateSnapshot = {
      ...emptyState(),
      preDueShownAt: new Date(NOW.getTime() - 60_000),
    };
    expect(evaluateAlertKind(activity, state, NOW)).toBeNull();
  });

  it("due recupera depois do horário se ainda incompleta e não shown", () => {
    const activity = baseActivity({ scheduledAt: DUE_AT });
    expect(evaluateAlertKind(activity, null, NOW)).toBe("DUE");
  });

  it("concluída ou scheduledAt null não alerta", () => {
    expect(evaluateAlertKind(baseActivity({ completed: true }), null, NOW)).toBeNull();
    expect(evaluateAlertKind(baseActivity({ scheduledAt: null }), null, NOW)).toBeNull();
  });

  it("dismiss definitivo bloqueia ambos os gatilhos", () => {
    const activity = baseActivity({ scheduledAt: DUE_AT });
    const state: AlertStateSnapshot = {
      ...emptyState(DUE_AT),
      dismissedAt: NOW,
    };
    expect(evaluateAlertKind(activity, state, NOW)).toBeNull();
  });

  it("snooze 10min bloqueia até snoozedUntil", () => {
    const activity = baseActivity({ scheduledAt: DUE_AT });
    const state: AlertStateSnapshot = {
      ...emptyState(DUE_AT),
      dueShownAt: null,
      snoozedUntil: new Date(NOW.getTime() + SNOOZE_MS),
      snoozedKind: "DUE",
    };
    expect(evaluateAlertKind(activity, state, NOW)).toBeNull();
    expect(
      evaluateAlertKind(activity, state, new Date(NOW.getTime() + SNOOZE_MS + 1)),
    ).toBe("DUE");
  });

  it("snooze PRE_DUE que atravessa scheduledAt vira DUE na reentrega", () => {
    const scheduledAt = new Date(NOW.getTime() + 5 * 60 * 1000);
    const activity = baseActivity({ scheduledAt });
    const afterSnooze = new Date(NOW.getTime() + SNOOZE_MS + 1);
    const state: AlertStateSnapshot = {
      ...emptyState(scheduledAt),
      preDueShownAt: null,
      snoozedUntil: new Date(NOW.getTime() + SNOOZE_MS),
      snoozedKind: "PRE_DUE",
    };
    expect(evaluateAlertKind(activity, state, afterSnooze)).toBe("DUE");
  });
});

describe("canSnoozeKind", () => {
  it("PRE_DUE só com preDueShownAt e now < scheduledAt", () => {
    const state: AlertStateSnapshot = {
      ...emptyState(SCHEDULED),
      preDueShownAt: NOW,
    };
    expect(canSnoozeKind("PRE_DUE", state, SCHEDULED, NOW)).toBe(true);
    expect(canSnoozeKind("DUE", state, SCHEDULED, NOW)).toBe(false);
    expect(canSnoozeKind("PRE_DUE", emptyState(SCHEDULED), SCHEDULED, NOW)).toBe(false);
    expect(canSnoozeKind("PRE_DUE", state, SCHEDULED, SCHEDULED)).toBe(false);
  });

  it("DUE só com dueShownAt e now >= scheduledAt", () => {
    const state: AlertStateSnapshot = {
      ...emptyState(DUE_AT),
      dueShownAt: NOW,
    };
    expect(canSnoozeKind("DUE", state, DUE_AT, NOW)).toBe(true);
    expect(canSnoozeKind("PRE_DUE", state, DUE_AT, NOW)).toBe(false);
  });
});

describe("reagendamento / reset", () => {
  it("scheduledFor diferente reseta estado", () => {
    const old = emptyState(new Date("2026-08-19T12:00:00.000Z"));
    old.preDueShownAt = NOW;
    old.dismissedAt = NOW;
    expect(needsAlertStateReset(old, SCHEDULED)).toBe(true);
    const reset = resetAlertStateFields(SCHEDULED);
    expect(reset.preDueShownAt).toBeNull();
    expect(reset.dismissedAt).toBeNull();
    expect(reset.scheduledFor).toEqual(SCHEDULED);
  });
});

describe("snooze / dismiss patches", () => {
  it("snooze define +10min e limpa shown do kind", () => {
    const patch = applySnoozeToState("PRE_DUE", NOW);
    expect(patch.snoozedUntil!.getTime()).toBe(NOW.getTime() + SNOOZE_MS);
    expect(patch.snoozedKind).toBe("PRE_DUE");
    expect(patch.preDueShownAt).toBeNull();
  });

  it("dismiss encerra", () => {
    const patch = applyDismissToState(emptyState(), NOW);
    expect(patch.dismissedAt).toEqual(NOW);
    expect(patch.snoozedUntil).toBeNull();
  });
});

describe("prioridade de seleção", () => {
  it("DUE mais antigo antes de PRE_DUE", () => {
    const dueOld: AlertCandidate = {
      activity: baseActivity({
        id: "due_old",
        scheduledAt: new Date("2026-08-19T10:00:00.000Z"),
      }),
      kind: "DUE",
      state: null,
    };
    const dueNew: AlertCandidate = {
      activity: baseActivity({
        id: "due_new",
        scheduledAt: new Date("2026-08-19T12:00:00.000Z"),
      }),
      kind: "DUE",
      state: null,
    };
    const pre: AlertCandidate = {
      activity: baseActivity({ id: "pre", scheduledAt: SCHEDULED }),
      kind: "PRE_DUE",
      state: null,
    };
    expect(compareAlertCandidates(dueOld, dueNew)).toBeLessThan(0);
    expect(compareAlertCandidates(dueNew, pre)).toBeLessThan(0);
    expect(pickNextAlertCandidate([pre, dueNew, dueOld])?.activity.id).toBe("due_old");
  });
});

describe("DTO / claim where / P2002", () => {
  it("monta contrato sem campos extras sensíveis", () => {
    const dto = buildAlertDto(baseActivity(), "PRE_DUE");
    expect(dto).toEqual({
      id: "act_1",
      kind: "PRE_DUE",
      title: "Ligar cliente",
      type: "CALL",
      scheduledAt: SCHEDULED.toISOString(),
      contact: { id: "c1", name: "Ana" },
      deal: null,
      department: null,
    });
  });

  it("buildOptimisticClaimWhere normal exige shown null + snooze ok", () => {
    const where = buildOptimisticClaimWhere({
      id: "st_1",
      kind: "DUE",
      scheduledFor: DUE_AT,
      now: NOW,
      mode: "normal",
    });
    expect(where).toMatchObject({
      id: "st_1",
      scheduledFor: DUE_AT,
      dismissedAt: null,
      dueShownAt: null,
    });
  });

  it("buildOptimisticClaimWhere reschedule usa scheduledFor anterior", () => {
    const prev = new Date("2026-08-19T10:00:00.000Z");
    const where = buildOptimisticClaimWhere({
      id: "st_1",
      kind: "DUE",
      scheduledFor: SCHEDULED,
      now: NOW,
      mode: "reschedule",
      previousScheduledFor: prev,
    });
    expect(where).toEqual({ id: "st_1", scheduledFor: prev });
  });

  it("isUniqueConstraintError detecta P2002", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(isUniqueConstraintError({ code: "P2003" })).toBe(false);
  });
});

describe("getNextActivityAlert delivery mark (mock prisma)", () => {
  beforeEach(() => {
    vi.resetModules();
    deliveryStore.activities = [];
    deliveryStore.states = [];
    deliveryStore.deptMembers = [];
    deliveryStore.forceUpdateManyLose = false;
    deliveryStore.forceCreateP2002 = false;
    vi.doMock("@/lib/prisma", () => ({ prisma: deliveryPrisma }));
    vi.doMock("@/services/task-visibility", () => ({
      getUserDepartmentIds: async (userId: string, organizationId: string) =>
        deliveryStore.deptMembers
          .filter((m) => m.userId === userId && m.organizationId === organizationId)
          .map((m) => m.departmentId),
    }));
  });

  it("GET marca entrega (preDueShownAt) antes de devolver", async () => {
    deliveryStore.activities.push({
      id: "act_1",
      organizationId: "org_1",
      title: "Ligar",
      type: "CALL",
      completed: false,
      scheduledAt: SCHEDULED,
      userId: "user_1",
      departmentId: null,
      contact: null,
      deal: null,
      department: null,
    });

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const alert = await getNextActivityAlert("user_1", "org_1", { now: NOW });
    expect(alert?.kind).toBe("PRE_DUE");
    expect(alert?.id).toBe("act_1");
    expect(deliveryStore.states).toHaveLength(1);
    expect(deliveryStore.states[0].preDueShownAt).toEqual(NOW);

    const second = await getNextActivityAlert("user_1", "org_1", { now: NOW });
    expect(second).toBeNull();
  });

  it("membro de departamento recebe; gestor sem vínculo não", async () => {
    deliveryStore.activities.push({
      id: "act_dept",
      organizationId: "org_1",
      title: "Fila",
      type: "TASK",
      completed: false,
      scheduledAt: DUE_AT,
      userId: null,
      departmentId: "dept_1",
      contact: null,
      deal: null,
      department: { id: "dept_1", name: "Suporte" },
    });
    deliveryStore.deptMembers.push({
      userId: "member_1",
      organizationId: "org_1",
      departmentId: "dept_1",
    });

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const forMember = await getNextActivityAlert("member_1", "org_1", { now: NOW });
    expect(forMember?.id).toBe("act_dept");

    const forManager = await getNextActivityAlert("manager_1", "org_1", { now: NOW });
    expect(forManager).toBeNull();
  });

  it("claim perdido (updateMany count 0) não devolve DTO; outro candidato ganha", async () => {
    deliveryStore.activities.push(
      {
        id: "act_a",
        organizationId: "org_1",
        title: "A",
        type: "CALL",
        completed: false,
        scheduledAt: new Date("2026-08-19T13:00:00.000Z"),
        userId: "user_1",
        departmentId: null,
        contact: null,
        deal: null,
        department: null,
      },
      {
        id: "act_b",
        organizationId: "org_1",
        title: "B",
        type: "CALL",
        completed: false,
        scheduledAt: new Date("2026-08-19T13:30:00.000Z"),
        userId: "user_1",
        departmentId: null,
        contact: null,
        deal: null,
        department: null,
      },
    );
    deliveryStore.states.push(
      {
        id: "st_a",
        organizationId: "org_1",
        activityId: "act_a",
        userId: "user_1",
        scheduledFor: new Date("2026-08-19T13:00:00.000Z"),
        preDueShownAt: null,
        dueShownAt: null,
        snoozedUntil: null,
        snoozedKind: null,
        dismissedAt: null,
      },
      {
        id: "st_b",
        organizationId: "org_1",
        activityId: "act_b",
        userId: "user_1",
        scheduledFor: new Date("2026-08-19T13:30:00.000Z"),
        preDueShownAt: null,
        dueShownAt: null,
        snoozedUntil: null,
        snoozedKind: null,
        dismissedAt: null,
      },
    );
    deliveryStore.forceUpdateManyLose = true;

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const alert = await getNextActivityAlert("user_1", "org_1", { now: NOW });
    expect(alert?.id).toBe("act_b");
    expect(deliveryStore.states.find((s) => s.activityId === "act_a")?.dueShownAt).toBeNull();
    expect(deliveryStore.states.find((s) => s.activityId === "act_b")?.dueShownAt).toEqual(NOW);
  });

  it("create concorrente P2002 = claim perdido (não explode)", async () => {
    deliveryStore.activities.push({
      id: "act_1",
      organizationId: "org_1",
      title: "Ligar",
      type: "CALL",
      completed: false,
      scheduledAt: SCHEDULED,
      userId: "user_1",
      departmentId: null,
      contact: null,
      deal: null,
      department: null,
    });
    deliveryStore.forceCreateP2002 = true;

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    await expect(getNextActivityAlert("user_1", "org_1", { now: NOW })).resolves.toBeNull();
    expect(deliveryStore.states).toHaveLength(0);
  });

  it("reagendamento concorrente: só um updateMany (scheduledFor anterior) ganha", async () => {
    const oldAt = new Date("2026-08-19T12:00:00.000Z");
    const newAt = DUE_AT;
    deliveryStore.activities.push({
      id: "act_1",
      organizationId: "org_1",
      title: "Reagendada",
      type: "CALL",
      completed: false,
      scheduledAt: newAt,
      userId: "user_1",
      departmentId: null,
      contact: null,
      deal: null,
      department: null,
    });
    deliveryStore.states.push({
      id: "st_1",
      organizationId: "org_1",
      activityId: "act_1",
      userId: "user_1",
      scheduledFor: oldAt,
      preDueShownAt: NOW,
      dueShownAt: NOW,
      snoozedUntil: null,
      snoozedKind: null,
      dismissedAt: NOW,
    });

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const first = await getNextActivityAlert("user_1", "org_1", { now: NOW });
    expect(first?.id).toBe("act_1");
    expect(first?.kind).toBe("DUE");
    expect(deliveryStore.states[0].scheduledFor).toEqual(newAt);
    expect(deliveryStore.states[0].dismissedAt).toBeNull();
    expect(deliveryStore.states[0].dueShownAt).toEqual(NOW);

    // Segundo caller: where scheduledFor=oldAt já não bate → sem DTO
    deliveryStore.forceUpdateManyLose = false;
    const second = await getNextActivityAlert("user_1", "org_1", { now: NOW });
    expect(second).toBeNull();
  });

  it("paginação sem starvation: pula página de dismissed e acha elegível", async () => {
    for (let i = 0; i < 3; i++) {
      const at = new Date(`2026-08-19T10:0${i}:00.000Z`);
      deliveryStore.activities.push({
        id: `old_${i}`,
        organizationId: "org_1",
        title: `Old ${i}`,
        type: "TASK",
        completed: false,
        scheduledAt: at,
        userId: "user_1",
        departmentId: null,
        contact: null,
        deal: null,
        department: null,
      });
      deliveryStore.states.push({
        id: `st_old_${i}`,
        organizationId: "org_1",
        activityId: `old_${i}`,
        userId: "user_1",
        scheduledFor: at,
        preDueShownAt: null,
        dueShownAt: NOW,
        snoozedUntil: null,
        snoozedKind: null,
        dismissedAt: null,
      });
    }
    deliveryStore.activities.push({
      id: "fresh",
      organizationId: "org_1",
      title: "Fresh",
      type: "CALL",
      completed: false,
      scheduledAt: DUE_AT,
      userId: "user_1",
      departmentId: null,
      contact: null,
      deal: null,
      department: null,
    });

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const alert = await getNextActivityAlert("user_1", "org_1", {
      now: NOW,
      pageSize: 2,
    });
    expect(alert?.id).toBe("fresh");
  });

  it("não carrega tarefas futuras além do horizonte 15min", async () => {
    const far = new Date(NOW.getTime() + PRE_DUE_WINDOW_MS + 60_000);
    deliveryStore.activities.push({
      id: "far",
      organizationId: "org_1",
      title: "Far",
      type: "CALL",
      completed: false,
      scheduledAt: far,
      userId: "user_1",
      departmentId: null,
      contact: null,
      deal: null,
      department: null,
    });

    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const alert = await getNextActivityAlert("user_1", "org_1", { now: NOW });
    expect(alert).toBeNull();
  });
});

describe("applyActivityAlertAction (mock)", () => {
  beforeEach(() => {
    vi.resetModules();
    actionStore.activities = [
      {
        id: "act_1",
        organizationId: "org_1",
        completed: false,
        scheduledAt: DUE_AT,
        userId: "user_1",
        departmentId: null,
      },
    ];
    actionStore.states = [
      {
        id: "st_1",
        organizationId: "org_1",
        activityId: "act_1",
        userId: "user_1",
        scheduledFor: DUE_AT,
        preDueShownAt: null,
        dueShownAt: NOW,
        snoozedUntil: null,
        snoozedKind: null,
        dismissedAt: null,
      },
    ];
    vi.doMock("@/lib/prisma", () => ({ prisma: actionPrisma }));
    vi.doMock("@/services/task-visibility", () => ({
      getUserDepartmentIds: async () => [],
    }));
  });

  it("dismiss definitivo", async () => {
    const { applyActivityAlertAction } = await import("@/services/activity-alerts");
    const result = await applyActivityAlertAction(
      "user_1",
      "org_1",
      "act_1",
      { action: "dismiss" },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(actionStore.states[0].dismissedAt).toEqual(NOW);
  });

  it("snooze 10min limpa dueShownAt", async () => {
    const { applyActivityAlertAction } = await import("@/services/activity-alerts");
    const result = await applyActivityAlertAction(
      "user_1",
      "org_1",
      "act_1",
      { action: "snooze", kind: "DUE" },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(actionStore.states[0].dueShownAt).toBeNull();
    expect((actionStore.states[0].snoozedUntil as Date).getTime()).toBe(
      NOW.getTime() + SNOOZE_MS,
    );
  });

  it("snooze kind stale/malicioso → 400", async () => {
    const { applyActivityAlertAction } = await import("@/services/activity-alerts");
    const result = await applyActivityAlertAction(
      "user_1",
      "org_1",
      "act_1",
      { action: "snooze", kind: "PRE_DUE" },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("não destinatário recebe 403", async () => {
    const { applyActivityAlertAction } = await import("@/services/activity-alerts");
    const result = await applyActivityAlertAction(
      "other_user",
      "org_1",
      "act_1",
      { action: "dismiss" },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe("getNextActivityAlert janela/teto/activityIds (BD-8)", () => {
  beforeEach(() => {
    vi.resetModules();
    deliveryStore.activities = [];
    deliveryStore.states = [];
    deliveryStore.deptMembers = [];
    deliveryPrisma.activity.findMany.mockClear();
    vi.doMock("@/lib/prisma", () => ({ prisma: deliveryPrisma }));
    vi.doMock("@/services/task-visibility", () => ({
      getUserDepartmentIds: async () => [],
    }));
  });

  it("filtra por janela inferior (lookback) e restringe a activityIds", async () => {
    const { getNextActivityAlert, ALERT_LOOKBACK_MS } = await import(
      "@/services/activity-alerts"
    );
    await getNextActivityAlert("user_1", "org_1", {
      now: NOW,
      activityIds: ["act_x", "act_y"],
    });
    const args = deliveryPrisma.activity.findMany.mock.calls[0][0] as {
      where: { scheduledAt: { gte: Date; lte: Date }; id?: { in: string[] } };
    };
    expect(args.where.scheduledAt.gte).toEqual(
      new Date(NOW.getTime() - ALERT_LOOKBACK_MS),
    );
    expect(args.where.id).toEqual({ in: ["act_x", "act_y"] });
  });

  it("activityIds vazio não consulta", async () => {
    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const r = await getNextActivityAlert("user_1", "org_1", {
      now: NOW,
      activityIds: [],
    });
    expect(r).toBeNull();
    expect(deliveryPrisma.activity.findMany).not.toHaveBeenCalled();
  });

  it("respeita o teto de páginas", async () => {
    for (let i = 0; i < 6; i++) {
      deliveryStore.activities.push({
        id: `act_${i}`,
        organizationId: "org_1",
        title: "x",
        type: "TASK",
        completed: false,
        // fora do horizonte de kind (já mostrado) — nada entregável
        scheduledAt: DUE_AT,
        userId: "outro",
        departmentId: null,
      });
    }
    const { getNextActivityAlert } = await import("@/services/activity-alerts");
    const r = await getNextActivityAlert("user_1", "org_1", {
      now: NOW,
      pageSize: 2,
      maxPages: 2,
    });
    expect(r).toBeNull();
    expect(deliveryPrisma.activity.findMany).toHaveBeenCalledTimes(2);
  });
});
