/**
 * BD-20: `distributionPending.findMany` (take 500) era repetido por
 * departamento dentro de `drainBucket`; o `conversation.count` da fila era
 * refeito em cada saída antecipada. Agora: um findMany por passada e um
 * count memoizado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pendingFindMany: vi.fn(async () => [{ conversationId: "conv_ai" }]),
  convFindMany: vi.fn(async (args: { where?: { departmentId?: unknown; select?: unknown } }) => {
    void args;
    return [] as Array<{ id: string; contactId: string; departmentId: string | null }>;
  }),
  convCount: vi.fn(async () => 3),
  drainState: {
    running: false,
    queuedTrigger: null as string | null,
    queuedUserId: null as string | null,
    timer: null,
    cooldownUntil: 0,
    cooldownReason: null as string | null,
    coalesceLogged: false,
  },
  responsibles: [] as Array<{
    userId: string;
    eligible: boolean;
    departments: Array<{ id: string }>;
  }>,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    distributionPending: { findMany: h.pendingFindMany },
    conversation: { findMany: h.convFindMany, count: h.convCount },
  },
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org_1",
  runWithContext: async (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/distribution-drain-queue", () => ({
  allowInlineDistributionFallback: () => false,
  enqueueDistributionDrain: vi.fn(async () => null),
  isFreshDrainEnqueue: () => false,
}));
vi.mock("@/lib/metrics", () => ({ metrics: { increment: vi.fn(), observe: vi.fn() } }));
vi.mock("@/lib/debug-log", () => ({ debugInfo: vi.fn(), debugWarn: vi.fn() }));
vi.mock("@/lib/inbox-queue-membership", () => ({
  activeInboxQueueGuardWhere: () => ({}),
}));
vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: async () => true,
}));
vi.mock("../engine", () => ({
  executeDistribution: vi.fn(async () => ({ success: false, reason: "OTHER" })),
}));
vi.mock("../enabled", () => ({ isDistributionEnabled: async () => true }));
vi.mock("../capacity-released-gate", () => ({
  evaluateCapacityReleasedDrain: async () => ({ proceed: true }),
}));
vi.mock("../pending-drain-store", () => ({
  peekPublishedFruitlessCooldown: async () => ({ armed: false }),
}));
vi.mock("../responsibles", () => ({
  getDistributionResponsibles: async () => h.responsibles,
}));
vi.mock("../pending-inbound", () => ({
  cancelStalePendingOrphans: async () => 0,
}));
vi.mock("../pending-shared", () => ({
  armFruitlessCooldown: vi.fn(),
  bypassFruitlessIfUserHasSlot: async () => false,
  clearFruitlessCooldown: vi.fn(),
  eligibleInDeptScope: (
    eligible: Array<{ departments: Array<{ id: string }> }>,
    deptId: string | null,
  ) =>
    eligible.filter((r) =>
      deptId === null ? true : r.departments.some((d) => d.id === deptId),
    ),
  explainEmptyDrain: async () => ({ skipReason: null, skipMessage: null }),
  getDrainState: () => h.drainState,
  getWaitingQueueWhere: vi.fn(async () => ({ assignedToId: null })),
  hasRemainingCapacityInScope: () => true,
  liveFreeCapacityForUser: () => 1,
  logCooldownSkip: vi.fn(),
  takeLimitForDept: () => 5,
}));

import { processPendingDistributionQueue } from "@/services/distribution/pending-drain";

beforeEach(() => {
  h.pendingFindMany.mockClear();
  h.convFindMany.mockClear();
  h.convCount.mockClear();
  h.drainState.running = false;
  h.responsibles = [
    { userId: "u1", eligible: true, departments: [{ id: "d1" }, { id: "d2" }] },
  ];
});

describe("processPendingDistributionQueue (BD-20)", () => {
  it("carrega pendingAiConvIds uma vez por passada, mesmo com vários buckets", async () => {
    const r = await processPendingDistributionQueue({ trigger: "manual" });
    expect(r.trigger).toBe("manual");
    // buckets: d1, d2 e org-wide (null) → 3 findMany de conversas...
    expect(h.convFindMany.mock.calls.filter((c) => "take" in (c[0] as object))).toHaveLength(3);
    // ...mas só 1 leitura de distributionPending
    expect(h.pendingFindMany).toHaveBeenCalledTimes(1);
    // e o resultado é usado em cada bucket (OR com id in [...])
    for (const call of h.convFindMany.mock.calls) {
      const where = (call[0] as { where: { OR?: unknown[] } }).where;
      if (!where.OR) continue;
      expect(where.OR).toContainEqual(
        expect.objectContaining({ id: { in: ["conv_ai"] } }),
      );
    }
    // contagem final: fila inteira + no escopo (pós-drenagem, não memoizada)
    expect(h.convCount).toHaveBeenCalledTimes(2);
  });

  it("saída antecipada (já rodando) conta a fila uma única vez", async () => {
    h.drainState.running = true;
    const r = await processPendingDistributionQueue({ trigger: "manual" });
    expect(r.skipReason).toBe("ALREADY_RUNNING");
    expect(r.pending).toBe(3);
    expect(h.convCount).toHaveBeenCalledTimes(1);
    expect(h.pendingFindMany).not.toHaveBeenCalled();
  });
});
