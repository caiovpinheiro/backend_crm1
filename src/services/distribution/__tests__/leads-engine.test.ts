/**
 * Testes do motor da Distribuição por Leads (modo "leads").
 *
 * Cobre: sorteio por bilhete (slot ativo = 1 bilhete, peso 0/1/3/5,
 * INACTIVE fora, mudança de peso), proporção ~3:1 entre participantes,
 * idempotência por DistributionLeadsExecution (retry não consome slot nem
 * duplica histórico), redistribuição com dono humano vigente e
 * NO_ELIGIBLE_PARTICIPANT (não entra em fila; routeMode permanece).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasOrganizationWidget = vi.fn(async () => true);
const isDistributionEnabled = vi.fn(async () => true);
const getConversationSession = vi.fn(async () => ({ active: false }));
const logEvent = vi.fn(async () => {});
const fireTrigger = vi.fn(async () => {});
const assignOwnerToContactClusterTx = vi.fn(async () => ({
  contactId: null,
  dealIds: [],
  fromOwnerId: null,
  pipelineIds: [],
  agentChangedDeals: [],
}));
const invalidateBoardsForPipelines = vi.fn(async () => {});

vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: (...a: unknown[]) => hasOrganizationWidget(...a),
}));
vi.mock("@/services/distribution/leads/enabled", () => ({
  isLeadsDistributionEnabled: () => isDistributionEnabled(),
}));
vi.mock("@/lib/channel-session", () => ({
  getConversationSession: (...a: unknown[]) => getConversationSession(...a),
}));
vi.mock("@/services/activity-log", () => ({
  logEvent: (...a: unknown[]) => logEvent(...a),
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: (...a: unknown[]) => fireTrigger(...a),
}));
vi.mock("@/services/deals", () => ({
  assignOwnerToContactClusterTx: (...a: unknown[]) =>
    assignOwnerToContactClusterTx(...a),
  invalidateBoardsForPipelines: (...a: unknown[]) =>
    invalidateBoardsForPipelines(...a),
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org1",
}));

// Regras de horário por departamento: setting + recorte calculado na tx.
// Desligadas por padrão (comportamento anterior do motor).
const departmentRulesEnabled = vi.fn(async () => false);
const departmentEligibleUserIds = vi.fn(async (): Promise<string[]> => []);
vi.mock("@/services/distribution/leads/department-rules", () => ({
  isLeadsDepartmentRulesEnabled: () => departmentRulesEnabled(),
  eligibleUserIdsByDepartmentRulesTx: () => departmentEligibleUserIds(),
}));

// ── Fake de banco em memória ──────────────────────────────────────────
type Participant = { id: string; userId: string; status: string; weight: number };
type Slot = {
  id: string;
  participantId: string;
  slotIndex: number;
  lastAssignedAt: number | null;
};
type Conv = {
  id: string;
  contactId: string;
  assignedToId: string | null;
  assignedVia: string | null;
  routeMode: string | null;
  assigneeType?: "HUMAN" | "AI";
};

const ORG = "org1";

let participants: Participant[];
let slots: Slot[];
let conversations: Map<string, Conv>;
let users: Map<string, { type: string; name: string }>;
let assignments: Record<string, unknown>[];
let pendingRows: {
  id: string;
  targetKey: string;
  status: string;
  attempts: number;
  conversationId: string | null;
  contactId: string | null;
  dealId: string | null;
  resolvedUserId: string | null;
  createdAt: number;
}[];
let executions: Map<string, { result: unknown; assignmentId: string | null }>;
let advisoryLocks: string[];
let slotUpdates: string[];

function resetDb() {
  overrideRows = [];
  participants = [];
  slots = [];
  conversations = new Map();
  users = new Map();
  assignments = [];
  pendingRows = [];
  executions = new Map();
  advisoryLocks = [];
  slotUpdates = [];
}

function addParticipant(userId: string, weight: number, status = "ACTIVE") {
  const pid = `p_${userId}`;
  participants.push({ id: pid, userId, status, weight });
  users.set(userId, { type: "HUMAN", name: `User ${userId}` });
  for (let i = 0; i < 5; i++) {
    slots.push({
      id: `s_${userId}_${i}`,
      participantId: pid,
      slotIndex: i,
      lastAssignedAt: null,
    });
  }
}

function addConversation(id: string, contactId: string, assignee: string | null, assigneeType: "HUMAN" | "AI" = "HUMAN") {
  conversations.set(id, {
    id,
    contactId,
    assignedToId: assignee,
    assignedVia: null,
    routeMode: null,
    assigneeType,
  });
}

/**
 * Replica da seleção do SQL: 1 bilhete por slot ativo, sorteio uniforme.
 * `allowedSets` = cada `IN (...)` da query (recorte explícito e/ou regras
 * por departamento) — o usuário precisa estar em todos (interseção).
 */
/** Liberação/pausa manual vigente (tabela distribution_leads_eligibility_overrides). */
let overrideRows: { userId: string; eligible: boolean; startsAt: Date; endsAt: Date }[] = [];

function selectSlotFake(allowedSets: Set<string>[] = [], excludedSets: Set<string>[] = []) {
  const eligible = slots.filter((s) => {
    const p = participants.find((pp) => pp.id === s.participantId);
    if (!p || p.status !== "ACTIVE" || p.weight <= 0) return false;
    if (s.slotIndex >= p.weight) return false;
    if (!allowedSets.every((set) => set.has(p.userId))) return false;
    if (excludedSets.some((set) => set.has(p.userId))) return false;
    return users.get(p.userId)?.type === "HUMAN";
  });
  if (eligible.length === 0) return [];
  const s = eligible[Math.floor(Math.random() * eligible.length)]!;
  const p = participants.find((pp) => pp.id === s.participantId)!;
  return [
    {
      id: s.id,
      participantId: s.participantId,
      slotIndex: s.slotIndex,
      userId: p.userId,
      userName: users.get(p.userId)?.name ?? null,
    },
  ];
}

function applyConversationCas(
  conv: Conv,
  data: { assignedToId: string; assignedVia: string; routeMode: null },
  where: {
    expectedOwnerId?: string | null;
    assignedToId?: string | null;
    OR?: unknown;
  },
): number {
  const hasOwnerPrecondition =
    where.expectedOwnerId != null ||
    where.assignedToId !== undefined ||
    where.OR != null;
  if (hasOwnerPrecondition) {
    if (where.assignedToId !== undefined) {
      if (conv.assignedToId !== where.assignedToId) return 0;
    } else if (where.expectedOwnerId) {
      if (conv.assignedToId !== where.expectedOwnerId) return 0;
    } else if (conv.assignedToId !== null && conv.assigneeType !== "AI") {
      return 0;
    }
  }
  conv.assignedToId = data.assignedToId;
  conv.assignedVia = data.assignedVia;
  conv.routeMode = null;
  return 1;
}

vi.mock("@/lib/prisma", () => {
  const conversationApi = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const c = conversations.get(where.id);
      if (!c) return null;
      return {
        id: c.id,
        contactId: c.contactId,
        assignedToId: c.assignedToId,
        assignedVia: c.assignedVia,
        routeMode: c.routeMode,
        departmentId: null,
        channel: "whatsapp",
        channelId: "ch1",
        lastInboundAt: new Date(),
        assignedTo: c.assignedToId
          ? { type: c.assigneeType ?? "HUMAN", name: `User ${c.assignedToId}` }
          : null,
      };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<Conv> }) => {
        const c = conversations.get(where.id);
        if (!c) throw new Error("conv not found");
        Object.assign(c, data);
        return c;
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; assignedToId?: string | null };
        data: { assignedToId: string; assignedVia: string; routeMode: null };
      }) => {
        const c = conversations.get(where.id);
        if (!c) return { count: 0 };
        return { count: applyConversationCas(c, data, where) };
      },
    ),
  };

  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      // O engine faz 2 queries raw na tx: MAX(lastAssignedAt) (carimbo
      // monotônico por org) e a seleção do slot.
      const strings = args[0] as TemplateStringsArray | undefined;
      const sql = strings ? String(strings[0]) : "";
      if (sql.includes("MAX(")) {
        const used = slots
          .map((s) => s.lastAssignedAt)
          .filter((t): t is number => t !== null);
        return [{ max: used.length ? new Date(Math.max(...used)) : null }];
      }
      // Fragmentos `IN (...)` / `NOT IN (...)` chegam como Prisma.Sql
      // (strings + values). `Prisma.empty` (sem recorte) não tem valores.
      const fragments = args
        .slice(1)
        .filter(
          (v): v is { values: unknown[]; strings: string[] } =>
            !!v && typeof v === "object" && Array.isArray((v as { values?: unknown }).values),
        )
        .map((v) => ({
          not: (v.strings ?? []).join(" ").includes("NOT IN"),
          set: new Set(v.values.filter((x): x is string => typeof x === "string")),
        }))
        .filter((f) => f.set.size > 0);
      return selectSlotFake(
        fragments.filter((f) => !f.not).map((f) => f.set),
        fragments.filter((f) => f.not).map((f) => f.set),
      );
    }),
    conversation: conversationApi,
    contact: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    deal: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    distributionLeadsEligibilityOverride: {
      findMany: vi.fn(async ({ where }: { where: { startsAt: { lte: Date }; endsAt: { gt: Date } } }) =>
        overrideRows.filter(
          (o) => o.startsAt <= where.startsAt.lte && o.endsAt > where.endsAt.gt,
        ),
      ),
    },
    distributionLeadsSlot: {
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { lastAssignedAt: Date } }) => {
          const s = slots.find((sl) => sl.id === where.id);
          if (!s) throw new Error("slot not found");
          s.lastAssignedAt = data.lastAssignedAt.getTime();
          slotUpdates.push(where.id);
          return s;
        },
      ),
    },
    distributionLeadsAssignment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        assignments.push(data);
        return { id: `a_${assignments.length}` };
      }),
    },
    distributionLeadsPending: {
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { status?: string; targetKey?: string };
          orderBy?: { createdAt?: "asc" | "desc" };
        }) => {
          let rows = pendingRows.filter((r) =>
            where.status ? r.status === where.status : true,
          );
          if (where.targetKey) rows = rows.filter((r) => r.targetKey === where.targetKey);
          if (orderBy?.createdAt === "asc") {
            rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
          }
          return rows[0] ?? null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `pend_${pendingRows.length + 1}`,
          targetKey: String(data.targetKey),
          status: String(data.status ?? "PENDING"),
          attempts: 1,
          conversationId: (data.conversationId as string | null) ?? null,
          contactId: (data.contactId as string | null) ?? null,
          dealId: (data.dealId as string | null) ?? null,
          resolvedUserId: null,
          createdAt: Date.now(),
        };
        pendingRows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = pendingRows.find((r) => r.id === where.id);
          if (!row) throw new Error("pending not found");
          const attempts = data.attempts as { increment?: number } | number | undefined;
          if (attempts && typeof attempts === "object" && attempts.increment) {
            row.attempts += attempts.increment;
          }
          if (typeof data.status === "string") row.status = data.status;
          if (typeof data.resolvedUserId === "string" || data.resolvedUserId === null) {
            row.resolvedUserId = data.resolvedUserId as string | null;
          }
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string };
          data: { status?: string; resolvedUserId?: string | null };
        }) => {
          const row = pendingRows.find(
            (r) => r.id === where.id && (!where.status || r.status === where.status),
          );
          if (!row) return { count: 0 };
          if (typeof data.status === "string") row.status = data.status;
          if (data.resolvedUserId !== undefined) row.resolvedUserId = data.resolvedUserId;
          return { count: 1 };
        },
      ),
    },
    distributionLeadsExecution: {
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: {
            automationContextId_stepId_occurrence: {
              automationContextId: string;
              stepId: string;
              occurrence: number;
            };
          };
          create: { result: unknown; assignmentId?: string | null };
        }) => {
          const k = `${where.automationContextId_stepId_occurrence.automationContextId}:${where.automationContextId_stepId_occurrence.stepId}:${where.automationContextId_stepId_occurrence.occurrence}`;
          if (!executions.has(k)) {
            executions.set(k, {
              result: create.result,
              assignmentId: create.assignmentId ?? null,
            });
          }
          return {};
        },
      ),
    },
  };

  const prisma = {
    conversation: conversationApi,
    contact: tx.contact,
    deal: tx.deal,
    distributionLeadsPending: tx.distributionLeadsPending,
    distributionLeadsExecution: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            automationContextId_stepId_occurrence: {
              automationContextId: string;
              stepId: string;
              occurrence: number;
            };
          };
        }) => {
          const k = `${where.automationContextId_stepId_occurrence.automationContextId}:${where.automationContextId_stepId_occurrence.stepId}:${where.automationContextId_stepId_occurrence.occurrence}`;
          const e = executions.get(k);
          return e ? { result: e.result } : null;
        },
      ),
      upsert: tx.distributionLeadsExecution.upsert,
    },
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => {
      // Registra o advisory lock do rodízio (a tx começa com ele).
      advisoryLocks.push(`${ORG}:leads-rotation`);
      return cb(tx);
    }),
  };
  return { prisma };
});

import { executeLeadsDistribution } from "../leads/engine";

describe("executeLeadsDistribution — sorteio por peso", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    hasOrganizationWidget.mockResolvedValue(true);
    isDistributionEnabled.mockResolvedValue(true);
    departmentRulesEnabled.mockResolvedValue(false);
    departmentEligibleUserIds.mockResolvedValue([]);
  });

  it("peso 0 não recebe; INACTIVE não recebe; sem elegível → NO_ELIGIBLE_PARTICIPANT mantendo routeMode", async () => {
    addParticipant("u1", 0); // peso 0 = fora
    addParticipant("u2", 3, "INACTIVE"); // inativo = fora
    addConversation("c1", "ct1", null);

    const r = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });

    expect(r.success).toBe(false);
    expect(r.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
    expect(assignments).toHaveLength(0);
    // routeMode marcado (fora do smart). Sem fila de espera.
    expect(conversations.get("c1")?.routeMode).toBe("leads");
    expect(pendingRows).toHaveLength(0);
  });

  it("sem peso não cria fila; linha antiga ainda é atribuída quando o peso sobe", async () => {
    addParticipant("Julia", 0);
    addConversation("c1", "ct1", null);

    const waiting = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });
    expect(waiting.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
    expect(conversations.get("c1")?.assignedToId).toBeNull();
    expect(pendingRows).toHaveLength(0);

    pendingRows.push({
      id: "pend_legacy",
      targetKey: "contact:ct1",
      status: "PENDING",
      attempts: 1,
      conversationId: "c1",
      contactId: "ct1",
      dealId: null,
      resolvedUserId: null,
      createdAt: Date.now(),
    });
    participants.find((p) => p.userId === "Julia")!.weight = 1;
    const { drainLeadsPending } = await import("../leads/pending");
    const assigned = await drainLeadsPending();

    expect(assigned).toBe(1);
    expect(conversations.get("c1")?.assignedToId).toBe("Julia");
    expect(pendingRows[0]?.status).toBe("RESOLVED");
    expect(pendingRows[0]?.resolvedUserId).toBe("Julia");
  });

  it("só um elegível: todos os leads vão para ele", async () => {
    addParticipant("u1", 2);
    addConversation("c1", "ct1", null);
    addConversation("c2", "ct2", null);
    addConversation("c3", "ct3", null);

    const got: string[] = [];
    for (const convId of ["c1", "c2", "c3"]) {
      const r = await executeLeadsDistribution({
        conversationId: convId,
        triggerSource: "AUTOMATION",
      });
      expect(r.success).toBe(true);
      got.push(r.selectedUserId!);
    }
    expect(got).toEqual(["u1", "u1", "u1"]);
    expect(slotUpdates).toHaveLength(3);
  });

  it("proporção ~3:1 — peso 3 tem 3 bilhetes contra 1", async () => {
    addParticipant("A", 3);
    addParticipant("B", 1);
    const seq: string[] = [];
    const TOTAL = 200;
    for (let i = 0; i < TOTAL; i++) {
      addConversation(`c${i}`, `ct${i}`, null);
      const r = await executeLeadsDistribution({
        conversationId: `c${i}`,
        triggerSource: "AUTOMATION",
      });
      expect(r.reason).toBe("ASSIGNED");
      seq.push(r.selectedUserId!);
    }
    const countA = seq.filter((s) => s === "A").length;
    const countB = seq.filter((s) => s === "B").length;
    expect(countA + countB).toBe(TOTAL);
    expect(countA).toBeGreaterThan(countB);
    expect(countA).toBeGreaterThanOrEqual(120);
    expect(countA).toBeLessThanOrEqual(180);
    expect(advisoryLocks.length).toBe(TOTAL);
    expect(assignments).toHaveLength(TOTAL);
  });

  it("mudança de peso vale só para recebimentos futuros", async () => {
    addParticipant("A", 1);
    addParticipant("B", 1);
    for (let i = 0; i < 2; i++) {
      addConversation(`c${i}`, `ct${i}`, null);
      await executeLeadsDistribution({ conversationId: `c${i}`, triggerSource: "AUTOMATION" });
    }
    participants.find((p) => p.userId === "A")!.weight = 5;
    const seq: string[] = [];
    for (let i = 2; i < 62; i++) {
      addConversation(`c${i}`, `ct${i}`, null);
      const r = await executeLeadsDistribution({
        conversationId: `c${i}`,
        triggerSource: "AUTOMATION",
      });
      seq.push(r.selectedUserId!);
    }
    const countA = seq.filter((s) => s === "A").length;
    const countB = seq.filter((s) => s === "B").length;
    expect(countA).toBeGreaterThan(countB);
  });

  it("dono humano existente é redistribuído pelo sorteio", async () => {
    addParticipant("A", 5);
    addConversation("c1", "ct1", "donoHumano");

    const r = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });

    expect(r.success).toBe(true);
    expect(r.reason).toBe("ASSIGNED");
    expect(r.selectedUserId).toBe("A");
    expect(conversations.get("c1")?.assignedToId).toBe("A");
    expect(conversations.get("c1")?.assignedVia).toBe("leads");
    expect(assignments).toHaveLength(1);
    expect(slotUpdates).toHaveLength(1);
    expect(slotUpdates[0]?.startsWith("s_A_")).toBe(true);
  });

  it("dono IA é substituído (handoff IA→humano) via CAS", async () => {
    addParticipant("A", 2);
    addConversation("c1", "ct1", "agenteIa", "AI");

    const r = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });

    expect(r.success).toBe(true);
    expect(r.reason).toBe("ASSIGNED");
    expect(r.selectedUserId).toBe("A");
    expect(conversations.get("c1")?.assignedVia).toBe("leads");
  });

  it("segunda execução no mesmo alvo redistribui de novo", async () => {
    addParticipant("A", 3);
    addConversation("c1", "ct1", null);
    // Simula: entre a leitura e o CAS, outro fluxo atribuiu.
    const conv = conversations.get("c1")!;
    const originalUpdate = conv.assignedToId;
    void originalUpdate;

    // Primeira execução normal...
    const r1 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });
    expect(r1.reason).toBe("ASSIGNED");
    expect(assignments).toHaveLength(1);

    const r2 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });
    expect(r2.reason).toBe("ASSIGNED");
    expect(r2.selectedUserId).toBe("A");
    expect(assignments).toHaveLength(2);
    expect(slotUpdates).toHaveLength(2);
    expect(slotUpdates.every((id) => id.startsWith("s_A_"))).toBe(true);
  });

  it("idempotência: retry do step retorna o outcome gravado sem consumir slot nem duplicar histórico", async () => {
    addParticipant("A", 3);
    addConversation("c1", "ct1", null);
    const execId = { automationContextId: "ctx1", stepId: "step9", occurrence: 1 };

    const r1 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
      ...execId,
    });
    expect(r1.reason).toBe("ASSIGNED");
    expect(assignments).toHaveLength(1);
    expect(slotUpdates).toHaveLength(1);

    const r2 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
      ...execId,
    });
    expect(r2).toEqual(r1);
    expect(assignments).toHaveLength(1);
    expect(slotUpdates).toHaveLength(1);

    const r3 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
      ...execId,
      occurrence: 2,
    });
    expect(r3.reason).toBe("ASSIGNED");
    expect(r3.selectedUserId).toBe("A");
    expect(assignments).toHaveLength(2);
    expect(slotUpdates).toHaveLength(2);
  });

  it("NO_ELIGIBLE também é idempotente por occurrence", async () => {
    addConversation("c1", "ct1", null);
    const execId = { automationContextId: "ctx1", stepId: "step9", occurrence: 1 };
    const r1 = await executeLeadsDistribution({
      conversationId: "c1",
      triggerSource: "AUTOMATION",
      ...execId,
    });
    expect(r1.reason).toBe("NO_ELIGIBLE_PARTICIPANT");

    // Participante criado depois: o retry da MESMA ocorrência não reavalia.
    addParticipant("A", 5);
    const r2 = await executeLeadsDistribution({
      conversationId: "c1",
      triggerSource: "AUTOMATION",
      ...execId,
    });
    expect(r2.reason).toBe("NO_ELIGIBLE_PARTICIPANT");

    // Nova ocorrência avalia de verdade.
    const r3 = await executeLeadsDistribution({
      conversationId: "c1",
      triggerSource: "AUTOMATION",
      ...execId,
      occurrence: 2,
    });
    expect(r3.reason).toBe("ASSIGNED");
    expect(r3.selectedUserId).toBe("A");
  });

  it("módulo desabilitado/widget ausente → falha sem tocar no alvo", async () => {
    addConversation("c1", "ct1", null);
    hasOrganizationWidget.mockResolvedValue(false);
    const r = await executeLeadsDistribution({
      conversationId: "c1",
      triggerSource: "AUTOMATION",
    });
    expect(r.success).toBe(false);
    expect(r.reason).toBe("SMART_DISTRIBUTION_NOT_ENABLED");
    expect(conversations.get("c1")?.routeMode).toBeNull();
  });

  it("kill switch próprio (distribution.leads.enabled=false) → DISTRIBUTION_DISABLED, sem tocar no alvo nem no smart", async () => {
    addParticipant("A", 3);
    addConversation("c1", "ct1", null);
    isDistributionEnabled.mockResolvedValue(false);

    const r = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });

    expect(r.success).toBe(false);
    expect(r.reason).toBe("DISTRIBUTION_DISABLED");
    expect(conversations.get("c1")?.assignedToId).toBeNull();
    expect(conversations.get("c1")?.routeMode).toBeNull();
    expect(assignments).toHaveLength(0);
  });
});

describe("executeLeadsDistribution — regras de horário por departamento", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    hasOrganizationWidget.mockResolvedValue(true);
    isDistributionEnabled.mockResolvedValue(true);
    departmentRulesEnabled.mockResolvedValue(false);
    departmentEligibleUserIds.mockResolvedValue([]);
  });

  async function run(convId: string) {
    return executeLeadsDistribution({
      conversationId: convId,
      contactId: `ct_${convId}`,
      triggerSource: "AUTOMATION",
    });
  }

  it("setting desligada: o recorte por departamento nem é consultado (comportamento anterior)", async () => {
    addParticipant("A", 3);
    addConversation("c1", "ct_c1", null);
    departmentEligibleUserIds.mockResolvedValue([]); // seria "ninguém" se valesse
    const r = await run("c1");
    expect(r.reason).toBe("ASSIGNED");
    expect(r.selectedUserId).toBe("A");
    expect(departmentEligibleUserIds).not.toHaveBeenCalled();
  });

  it("setting ligada: só quem está em departamento com regra ativa recebe", async () => {
    addParticipant("DIA", 5);
    addParticipant("NOITE", 5);
    addParticipant("TRES", 5); // departamento sem regra
    departmentRulesEnabled.mockResolvedValue(true);
    departmentEligibleUserIds.mockResolvedValue(["DIA"]); // 10h: só DIA ativo
    const got = new Set<string>();
    for (let i = 0; i < 30; i++) {
      addConversation(`c${i}`, `ct_c${i}`, null);
      const r = await run(`c${i}`);
      expect(r.reason).toBe("ASSIGNED");
      got.add(r.selectedUserId!);
    }
    expect([...got]).toEqual(["DIA"]);
    expect(departmentEligibleUserIds).toHaveBeenCalled();
  });

  it("sobreposição (15h–18h): DIA e NOITE recebem; membro dos dois entra uma vez e com o próprio peso", async () => {
    addParticipant("DIA", 1);
    addParticipant("AMBOS", 1);
    addParticipant("TRES", 5);
    departmentRulesEnabled.mockResolvedValue(true);
    // Conjunto já deduplicado pelo módulo de regras (AMBOS aparece uma vez).
    departmentEligibleUserIds.mockResolvedValue(["DIA", "AMBOS"]);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      addConversation(`c${i}`, `ct_c${i}`, null);
      const r = await run(`c${i}`);
      counts[r.selectedUserId!] = (counts[r.selectedUserId!] ?? 0) + 1;
    }
    expect(counts.TRES).toBeUndefined();
    // Peso 1 vs 1: proporção ~1:1 — estar em dois departamentos não dobra os bilhetes.
    const ratio = counts.AMBOS! / counts.DIA!;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("consultor do departamento ativo mas INACTIVE ou peso 0 não recebe → NO_ELIGIBLE_PARTICIPANT", async () => {
    addParticipant("DIA_INATIVO", 3, "INACTIVE");
    addParticipant("DIA_PESO0", 0);
    addParticipant("TRES", 5);
    addConversation("c1", "ct_c1", null);
    departmentRulesEnabled.mockResolvedValue(true);
    departmentEligibleUserIds.mockResolvedValue(["DIA_INATIVO", "DIA_PESO0"]);
    const r = await run("c1");
    expect(r.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
    expect(conversations.get("c1")?.assignedToId).toBeNull();
    expect(conversations.get("c1")?.routeMode).toBe("leads");
    expect(pendingRows).toHaveLength(0);
  });

  it("nenhuma regra ativa agora: ninguém recebe, mesmo com participantes com peso", async () => {
    addParticipant("A", 5);
    addConversation("c1", "ct_c1", null);
    departmentRulesEnabled.mockResolvedValue(true);
    departmentEligibleUserIds.mockResolvedValue([]);
    const r = await run("c1");
    expect(r.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
    expect(assignments).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "LEAD_DISTRIBUTION_FAILED",
        meta: expect.objectContaining({ departmentRules: true }),
      }),
    );
  });

  it("onlyUserIds continua valendo junto: interseção com o recorte por departamento", async () => {
    addParticipant("A", 5);
    addParticipant("B", 5);
    addParticipant("C", 5);
    departmentRulesEnabled.mockResolvedValue(true);
    departmentEligibleUserIds.mockResolvedValue(["A", "B"]);
    const got = new Set<string>();
    for (let i = 0; i < 20; i++) {
      addConversation(`c${i}`, `ct_c${i}`, null);
      const r = await executeLeadsDistribution({
        conversationId: `c${i}`,
        contactId: `ct_c${i}`,
        triggerSource: "AUTOMATION",
        onlyUserIds: ["B", "C"],
      });
      expect(r.reason).toBe("ASSIGNED");
      got.add(r.selectedUserId!);
    }
    expect([...got]).toEqual(["B"]);

    // Recorte explícito fora do horário de todos: ninguém, não cai no C.
    addConversation("cx", "ct_cx", null);
    departmentEligibleUserIds.mockResolvedValue([]);
    const r = await executeLeadsDistribution({
      conversationId: "cx",
      contactId: "ct_cx",
      triggerSource: "AUTOMATION",
      onlyUserIds: ["C"],
    });
    expect(r.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
  });

  it("idempotência preservada: retry fora do horário reencontra o ASSIGNED gravado", async () => {
    addParticipant("A", 5);
    addConversation("c1", "ct_c1", null);
    departmentRulesEnabled.mockResolvedValue(true);
    departmentEligibleUserIds.mockResolvedValue(["A"]);
    const id = { automationContextId: "ctx1", stepId: "s1", occurrence: 1 };
    const first = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct_c1",
      triggerSource: "AUTOMATION",
      ...id,
    });
    expect(first.reason).toBe("ASSIGNED");
    departmentEligibleUserIds.mockResolvedValue([]); // janela fechou
    const retry = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct_c1",
      triggerSource: "AUTOMATION",
      ...id,
    });
    expect(retry).toEqual(first);
    expect(assignments).toHaveLength(1);
  });
});

describe("executeLeadsDistribution — liberação/pausa manual temporária", () => {
  const hour = 3_600_000;
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    hasOrganizationWidget.mockResolvedValue(true);
    isDistributionEnabled.mockResolvedValue(true);
    departmentRulesEnabled.mockResolvedValue(true);
    departmentEligibleUserIds.mockResolvedValue([]);
  });

  function override(userId: string, eligible: boolean, fromMs: number, toMs: number) {
    const now = Date.now();
    overrideRows.push({
      userId,
      eligible,
      startsAt: new Date(now + fromMs),
      endsAt: new Date(now + toMs),
    });
  }

  async function run(convId: string) {
    addConversation(convId, `ct_${convId}`, null);
    return executeLeadsDistribution({
      conversationId: convId,
      contactId: `ct_${convId}`,
      triggerSource: "AUTOMATION",
    });
  }

  it("fora do horário do departamento, quem foi liberado até mais tarde recebe (hora extra)", async () => {
    addParticipant("MANHA", 3);
    addParticipant("OUTRA", 3);
    override("MANHA", true, -hour, 4 * hour);
    for (let i = 0; i < 10; i++) {
      const r = await run(`c${i}`);
      expect(r.reason).toBe("ASSIGNED");
      expect(r.selectedUserId).toBe("MANHA");
    }
  });

  it("liberação vencida não vale mais: volta à regra do departamento (ninguém no horário)", async () => {
    addParticipant("MANHA", 3);
    override("MANHA", true, -5 * hour, -hour);
    const r = await run("c1");
    expect(r.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
  });

  it("pausado no horário do departamento não recebe; os outros do departamento sim", async () => {
    addParticipant("DIA1", 3);
    addParticipant("DIA2", 3);
    departmentEligibleUserIds.mockResolvedValue(["DIA1", "DIA2"]);
    override("DIA1", false, -hour, hour);
    for (let i = 0; i < 10; i++) {
      const r = await run(`c${i}`);
      expect(r.selectedUserId).toBe("DIA2");
    }
  });

  it("pausa vale mesmo com as regras por departamento desligadas", async () => {
    departmentRulesEnabled.mockResolvedValue(false);
    addParticipant("A", 3);
    addParticipant("B", 3);
    override("A", false, -hour, hour);
    for (let i = 0; i < 10; i++) {
      const r = await run(`c${i}`);
      expect(r.selectedUserId).toBe("B");
    }
  });

  it("liberado mas INATIVO ou peso 0 continua sem receber", async () => {
    addParticipant("INATIVO", 3, "INACTIVE");
    addParticipant("PESO0", 0);
    override("INATIVO", true, -hour, hour);
    override("PESO0", true, -hour, hour);
    const r = await run("c1");
    expect(r.reason).toBe("NO_ELIGIBLE_PARTICIPANT");
  });
});
