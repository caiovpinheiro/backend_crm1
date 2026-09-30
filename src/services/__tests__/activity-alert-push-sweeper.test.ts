/**
 * BD-8: uma consulta por org (NOT EXISTS em activity_alert_states) e
 * `getNextActivityAlert` só para quem tem candidata, dentro de
 * withSystemContext da org — sem isso o prisma com escopo de tenant lança
 * e ninguem recebe aviso com o app fechado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  subs: [] as Array<{ userId: string; organizationId: string }>,
  contexts: [] as string[],
  rawCalls: [] as Array<{ sql: string; values: unknown[] }>,
  rawRows: new Map<string, Array<{ userId: string; activityId: string; scheduledAt: Date }>>(),
  getNextActivityAlert: vi.fn(
    async (_u: string, _o: string, _opts?: { activityIds?: string[] }) => null as null | { id: string },
  ),
}));

vi.mock("@prisma/client", () => ({
  Prisma: { join: (xs: unknown[]) => ({ __join: xs }) },
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    webPushSubscription: { findMany: vi.fn(async () => h.subs) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.rawCalls.push({ sql: strings.join("?"), values });
      // organizationId é o 3º parâmetro (ids, ids, org, ...)
      const org = values[2] as string;
      return h.rawRows.get(org) ?? [];
    }),
  },
}));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: vi.fn(async (organizationId: string, handler: () => unknown) => {
    h.contexts.push(organizationId);
    return handler();
  }),
}));
vi.mock("@/lib/fcm", () => ({
  FCM_ENDPOINT_PREFIX: "fcm:",
  isFcmConfigured: () => true,
}));
vi.mock("@/services/activity-alerts", () => ({
  ALERT_LOOKBACK_MS: 7 * 24 * 60 * 60 * 1000,
  PRE_DUE_WINDOW_MS: 15 * 60 * 1000,
  getNextActivityAlert: h.getNextActivityAlert,
}));

import {
  PUSH_MAX_PER_USER_PER_TICK,
  listUndeliveredAlertCandidates,
  sweepActivityAlertPushes,
} from "@/services/activity-alert-push-sweeper";

const NOW = new Date("2026-09-30T12:00:00.000Z");

beforeEach(() => {
  h.subs.length = 0;
  h.contexts.length = 0;
  h.rawCalls.length = 0;
  h.rawRows.clear();
  h.getNextActivityAlert.mockReset();
  h.getNextActivityAlert.mockResolvedValue(null);
});

describe("listUndeliveredAlertCandidates", () => {
  it("uma consulta com NOT EXISTS, janela inferior e teto; agrupa por usuário", async () => {
    h.rawRows.set("org-1", [
      { userId: "u1", activityId: "a1", scheduledAt: NOW },
      { userId: "u1", activityId: "a2", scheduledAt: NOW },
      { userId: "u2", activityId: "a1", scheduledAt: NOW },
    ]);
    const byUser = await listUndeliveredAlertCandidates("org-1", ["u1", "u2"], NOW);
    expect([...byUser.entries()]).toEqual([
      ["u1", ["a1", "a2"]],
      ["u2", ["a1"]],
    ]);
    expect(h.rawCalls).toHaveLength(1);
    const { sql, values } = h.rawCalls[0];
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1\s+FROM "activity_alert_states" s/);
    expect(sql).toMatch(/a\."scheduledAt" >= \?/);
    expect(sql).toMatch(/a\."scheduledAt" <= \?/);
    expect(sql).toMatch(/"department_members" dm/);
    expect(sql).toMatch(/LIMIT \?/);
    // since = now - 7d; horizon = now + 15min
    expect(values[3]).toEqual(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000));
    expect(values[4]).toEqual(new Date(NOW.getTime() + 15 * 60 * 1000));
  });

  it("sem usuários não consulta", async () => {
    const byUser = await listUndeliveredAlertCandidates("org-1", [], NOW);
    expect(byUser.size).toBe(0);
    expect(h.rawCalls).toHaveLength(0);
  });
});

describe("sweepActivityAlertPushes", () => {
  it("uma consulta por org; getNextActivityAlert só para quem tem candidata, no contexto da org", async () => {
    h.subs.push(
      { userId: "u1", organizationId: "org-1" },
      { userId: "u2", organizationId: "org-1" },
      { userId: "u3", organizationId: "org-2" },
    );
    h.rawRows.set("org-1", [{ userId: "u2", activityId: "a9", scheduledAt: NOW }]);
    h.getNextActivityAlert
      .mockResolvedValueOnce({ id: "a9" })
      .mockResolvedValue(null);

    const result = await sweepActivityAlertPushes(NOW);

    expect(result).toEqual({ users: 3, orgs: 2, candidates: 1, delivered: 1 });
    expect(h.rawCalls).toHaveLength(2);
    expect(h.contexts).toEqual(["org-1"]);
    expect(h.getNextActivityAlert).toHaveBeenCalledTimes(1);
    expect(h.getNextActivityAlert).toHaveBeenCalledWith("u2", "org-1", {
      now: NOW,
      activityIds: ["a9"],
    });
  });

  it("entrega até o teto por usuário removendo a candidata já entregue", async () => {
    h.subs.push({ userId: "u1", organizationId: "org-1" });
    const ids = Array.from({ length: PUSH_MAX_PER_USER_PER_TICK + 2 }, (_, i) => `a${i}`);
    h.rawRows.set(
      "org-1",
      ids.map((activityId) => ({ userId: "u1", activityId, scheduledAt: NOW })),
    );
    h.getNextActivityAlert.mockImplementation(async (_u, _o, opts) => ({
      id: opts!.activityIds![0],
    }));

    const result = await sweepActivityAlertPushes(NOW);

    expect(result.delivered).toBe(PUSH_MAX_PER_USER_PER_TICK);
    expect(h.getNextActivityAlert).toHaveBeenCalledTimes(PUSH_MAX_PER_USER_PER_TICK);
    const second = h.getNextActivityAlert.mock.calls[1][2]!;
    expect(second.activityIds).not.toContain("a0");
  });

  it("falha de um usuario ou de uma org nao interrompe os demais", async () => {
    h.subs.push(
      { userId: "u1", organizationId: "org-1" },
      { userId: "u2", organizationId: "org-1" },
      { userId: "u3", organizationId: "org-2" },
    );
    h.rawRows.set("org-1", [
      { userId: "u1", activityId: "a1", scheduledAt: NOW },
      { userId: "u2", activityId: "a2", scheduledAt: NOW },
    ]);
    h.rawRows.set("org-2", [{ userId: "u3", activityId: "a3", scheduledAt: NOW }]);
    h.getNextActivityAlert
      .mockRejectedValueOnce(new Error("fora de contexto"))
      .mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sweepActivityAlertPushes(NOW);

    expect(result.users).toBe(3);
    expect(h.getNextActivityAlert).toHaveBeenCalledTimes(3);
    expect(h.contexts).toEqual(["org-1", "org-1", "org-2"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
