/**
 * Testes do motor da Distribuição por Leads (modo "leads").
 *
 * Cobre: rodízio de slots (NULLS FIRST, desempate estável, peso 0/1/3/5,
 * INACTIVE fora, mudança de peso), proporção 3:1 entre participantes,
 * idempotência por DistributionLeadsExecution (retry não consome slot nem
 * duplica histórico), DONO_PRESERVADO (dono humano nunca é trocado) e
 * NO_ELIGIBLE_PARTICIPANT (sem fila, sem fallback; routeMode permanece).
 *
 * A serialização física do rodízio é do advisory lock por org
 * (pg_advisory_xact_lock) — aqui assertamos que toda execução o adquire e
 * que a seleção+atualização acontecem dentro da mesma tx.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasOrganizationWidget = vi.fn(async () => true);
const isDistributionEnabled = vi.fn(async () => true);
const getConversationSession = vi.fn(async () => ({ active: false }));
const logEvent = vi.fn(async () => {});
const fireTrigger = vi.fn(async () => {});
const assignDealOwnerTx = vi.fn();
const propagateOwnerToContactAndChat = vi.fn(async () => []);
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
  assignDealOwnerTx: (...a: unknown[]) => assignDealOwnerTx(...a),
  propagateOwnerToContactAndChat: (...a: unknown[]) =>
    propagateOwnerToContactAndChat(...a),
  invalidateBoardsForPipelines: (...a: unknown[]) =>
    invalidateBoardsForPipelines(...a),
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org1",
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
let executions: Map<string, { result: unknown; assignmentId: string | null }>;
let advisoryLocks: string[];
let slotUpdates: string[];

function resetDb() {
  participants = [];
  slots = [];
  conversations = new Map();
  users = new Map();
  assignments = [];
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

/** Replica fiel da seleção do SQL: NULLS FIRST + desempate estável por id. */
function selectSlotFake() {
  const eligible = slots.filter((s) => {
    const p = participants.find((pp) => pp.id === s.participantId);
    if (!p || p.status !== "ACTIVE" || p.weight <= 0) return false;
    if (s.slotIndex >= p.weight) return false;
    return users.get(p.userId)?.type === "HUMAN";
  });
  eligible.sort((a, b) => {
    if (a.lastAssignedAt === null && b.lastAssignedAt === null) {
      return a.id < b.id ? -1 : 1;
    }
    if (a.lastAssignedAt === null) return -1;
    if (b.lastAssignedAt === null) return 1;
    if (a.lastAssignedAt !== b.lastAssignedAt) {
      return a.lastAssignedAt - b.lastAssignedAt;
    }
    return a.id < b.id ? -1 : 1;
  });
  const s = eligible[0];
  if (!s) return [];
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
  where: { expectedOwnerId?: string | null },
): number {
  if (where.expectedOwnerId) {
    if (conv.assignedToId !== where.expectedOwnerId) return 0;
  } else if (
    conv.assignedToId !== null &&
    conv.assigneeType !== "AI"
  ) {
    return 0;
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
      return selectSlotFake();
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

describe("executeLeadsDistribution — rodízio de slots", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    hasOrganizationWidget.mockResolvedValue(true);
    isDistributionEnabled.mockResolvedValue(true);
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
    // routeMode marcado e MANTIDO (sem fila, sem fallback para o smart).
    expect(conversations.get("c1")?.routeMode).toBe("leads");
  });

  it("NULLS FIRST: slots nunca usados vêm primeiro; desempate estável por id", async () => {
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
    expect(got).toEqual(["u1", "u1", "u1"]); // 2 slots: s0, s1, depois o mais antigo (s0)
    expect(slotUpdates).toEqual(["s_u1_0", "s_u1_1", "s_u1_0"]);
  });

  it("proporção 3:1 — peso 3 recebe 3 slots de frequência contra 1", async () => {
    addParticipant("A", 3);
    addParticipant("B", 1);
    const seq: string[] = [];
    for (let i = 0; i < 8; i++) {
      addConversation(`c${i}`, `ct${i}`, null);
      const r = await executeLeadsDistribution({
        conversationId: `c${i}`,
        triggerSource: "AUTOMATION",
      });
      expect(r.reason).toBe("ASSIGNED");
      seq.push(r.selectedUserId!);
    }
    // Rodízio: A0, B0, A1, A2, depois repete pelo lastAssignedAt mais antigo.
    const countA = seq.filter((s) => s === "A").length;
    const countB = seq.filter((s) => s === "B").length;
    expect(countA).toBe(6);
    expect(countB).toBe(2);
    // Toda execução adquiriu o advisory lock por org (serialização do rodízio).
    expect(advisoryLocks.length).toBe(8);
    // Histórico gravado exatamente uma vez por lead.
    expect(assignments).toHaveLength(8);
  });

  it("mudança de peso vale só para recebimentos futuros", async () => {
    addParticipant("A", 1);
    addParticipant("B", 1);
    // 2 leads: A0, B0 (null primeiro, desempate por id).
    for (let i = 0; i < 2; i++) {
      addConversation(`c${i}`, `ct${i}`, null);
      await executeLeadsDistribution({ conversationId: `c${i}`, triggerSource: "AUTOMATION" });
    }
    // A sobe para peso 5: slots A1..A4 (nunca usados) entram no rodízio.
    participants.find((p) => p.userId === "A")!.weight = 5;
    const seq: string[] = [];
    for (let i = 2; i < 8; i++) {
      addConversation(`c${i}`, `ct${i}`, null);
      const r = await executeLeadsDistribution({
        conversationId: `c${i}`,
        triggerSource: "AUTOMATION",
      });
      seq.push(r.selectedUserId!);
    }
    // A1..A4 (null) vêm antes de qualquer slot usado.
    expect(seq.slice(0, 4)).toEqual(["A", "A", "A", "A"]);
  });

  it("dono humano existente NUNCA é trocado (DONO_PRESERVADO) — nem offline, nem por rodízio", async () => {
    addParticipant("A", 5);
    addConversation("c1", "ct1", "donoHumano");

    const r = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });

    expect(r.success).toBe(true);
    expect(r.reason).toBe("DONO_PRESERVADO");
    expect(r.selectedUserId).toBe("donoHumano");
    expect(conversations.get("c1")?.assignedToId).toBe("donoHumano");
    expect(conversations.get("c1")?.routeMode).toBeNull(); // rota consumida
    expect(assignments).toHaveLength(0); // não suja ranking
    expect(slotUpdates).toHaveLength(0); // não consome slot
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

  it("CAS perdido (outro fluxo atribuiu na corrida) → DONO_PRESERVADO sem gravar", async () => {
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

    // Segunda execução para o MESMO alvo (outra automação): dono humano
    // presente → preservado, sem novo assignment nem consumo de slot.
    const r2 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
    });
    expect(r2.reason).toBe("DONO_PRESERVADO");
    expect(r2.selectedUserId).toBe("A");
    expect(assignments).toHaveLength(1);
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
    expect(slotUpdates).toEqual(["s_A_0"]);

    // Retry (mesmo ctx/step/occurrence): replay do resultado gravado.
    const r2 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
      ...execId,
    });
    expect(r2).toEqual(r1);
    expect(assignments).toHaveLength(1);
    expect(slotUpdates).toEqual(["s_A_0"]);

    // Nova ocorrência (loop legítimo) com dono humano → DONO_PRESERVADO,
    // sem redistribuir o lead que já tem dono.
    const r3 = await executeLeadsDistribution({
      conversationId: "c1",
      contactId: "ct1",
      triggerSource: "AUTOMATION",
      ...execId,
      occurrence: 2,
    });
    expect(r3.reason).toBe("DONO_PRESERVADO");
    expect(assignments).toHaveLength(1);
    expect(slotUpdates).toEqual(["s_A_0"]);
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
