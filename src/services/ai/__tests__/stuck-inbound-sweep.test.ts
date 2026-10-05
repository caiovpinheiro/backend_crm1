/**
 * Varredura de segurança (`stuck-inbound`) não regrava as mesmas conversas.
 *
 * Produção (5,9 dias): 8.435 rodadas devolveram sempre o lote cheio de 50
 * e houve 421.750 `UPDATE conversations SET departmentId, assignedToId,
 * updatedAt` — as mesmas conversas, regravadas a cada minuto.
 *
 * Aqui o handoff genérico e o motor (`executeDistribution`) são os REAIS,
 * sobre um banco em memória que conta cada gravação em `conversations` e
 * cada evento. A consulta SQL é emulada em JS com os mesmos parâmetros
 * (o texto do SQL é conferido num teste à parte).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Conv = {
  id: string;
  number: number;
  organizationId: string;
  contactId: string;
  assignedToId: string | null;
  departmentId: string | null;
  status: string;
  hasHumanReply: boolean;
  lastInboundAt: Date;
  lastOutboundAt: Date | null;
  channelName: string | null;
  updatedAt: Date;
};
type Pending = {
  id: string;
  status: string;
  conversationId: string | null;
  contactId: string | null;
  dealId: string | null;
  attempts: number;
  triggerSource: string;
};
type Responsible = {
  userId: string;
  name: string;
  eligible: boolean;
  blockedReasons: string[];
  queueCount: number;
  volume: number;
  departments: { id: string }[];
};

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  return {
    convs: new Map<string, Conv>(),
    pendings: [] as Pending[],
    users: new Map<string, { type: "AI" | "HUMAN"; name: string; agentActive?: boolean }>(),
    orgs: new Map<string, { widget: boolean; enabled: boolean }>(),
    departments: new Map<string, { id: string; name: string }>(),
    responsibles: [] as Responsible[],
    currentOrg: "org1",
    sql: [] as string[],
    counts: {
      conversationWrites: 0,
      activityEvents: 0,
      timelineEvents: 0,
      distributionLogs: 0,
      pendingWrites: 0,
      handoffs: 0,
    },
  };
});

function convView(c: Conv) {
  const user = c.assignedToId ? h.users.get(c.assignedToId) : null;
  return {
    ...c,
    channelRef: { name: c.channelName, phoneNumber: null, config: null },
    assignedTo: user ? { type: user.type } : null,
    department: null,
    channel: "whatsapp",
    channelId: null,
  };
}

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    // Emula `listStuckInbound`. Ordem dos parâmetros = ordem no SQL.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.sql.push(strings.join("?"));
      const [blockedOrgs, excludeIds, cutoff, since, org, , limit] = values as [
        string[],
        string[],
        Date,
        Date,
        string,
        string,
        number,
      ];
      const rows = [...h.convs.values()].filter((c) => {
        const user = c.assignedToId ? h.users.get(c.assignedToId) : null;
        const stuckWithAi = user?.type === "AI" && user.agentActive === true;
        const unassigned =
          c.assignedToId === null && !blockedOrgs.includes(c.organizationId);
        if (!stuckWithAi && !unassigned) return false;
        if (excludeIds.includes(c.id)) return false;
        if (c.status !== "OPEN" || c.hasHumanReply) return false;
        if (!(c.lastInboundAt < cutoff) || !(c.lastInboundAt >= since)) return false;
        if (org !== "" && c.organizationId !== org) return false;
        if (c.lastOutboundAt && c.lastOutboundAt > c.lastInboundAt) return false;
        const inQueue = h.pendings.some(
          (p) =>
            p.status === "PENDING" &&
            (p.conversationId === c.id || p.contactId === c.contactId),
        );
        return !inQueue;
      });
      rows.sort(
        (a, b) =>
          Number(a.assignedToId === null) - Number(b.assignedToId === null) ||
          a.lastInboundAt.getTime() - b.lastInboundAt.getTime() ||
          a.id.localeCompare(b.id),
      );
      return rows.slice(0, limit).map((c) => ({
        conversation_id: c.id,
        conversation_number: c.number,
        contact_id: c.contactId,
        contact_name: `Contato ${c.number}`,
        contact_phone: null,
        organization_id: c.organizationId,
        assigned_to_id: c.assignedToId,
        last_inbound_at: c.lastInboundAt,
        channel_name: c.channelName,
        channel_phone: null,
        channel_config: null,
      }));
    }),
  },
}));

vi.mock("@/lib/prisma", async () => {
  const { createEmptyPrismaClient } = await import("@/test-setup/mock-prisma-base");
  const client = createEmptyPrismaClient();
  const updateConv = (id: string, data: Partial<Conv>) => {
    const row = h.convs.get(id);
    if (!row) throw Object.assign(new Error("conversa não existe"), { code: "P2025" });
    h.counts.conversationWrites++;
    Object.assign(row, data, { updatedAt: new Date() });
    return { id };
  };
  client.conversation = {
    findUnique: async (args: { where: { id: string } }) => {
      const row = h.convs.get(args.where.id);
      return row ? convView(row) : null;
    },
    findFirst: async () => null,
    update: async (args: { where: { id: string }; data: Partial<Conv> }) =>
      updateConv(args.where.id, args.data),
    updateMany: async () => {
      h.counts.conversationWrites++;
      return { count: 0 };
    },
  };
  client.user = {
    findUnique: async (args: { where: { id: string } }) =>
      h.users.get(args.where.id) ?? null,
  };
  client.department = {
    findUnique: async (args: { where: { id: string } }) => {
      const d = h.departments.get(args.where.id);
      return d ? { ...d, distributionEnabled: true, distributionMode: "smart" } : null;
    },
    findMany: async (args: { where: { id?: { in: string[] } } }) =>
      [...h.departments.values()]
        .filter((d) => !args.where.id || args.where.id.in.includes(d.id))
        .map((d) => ({ ...d, distributionMode: "smart" })),
  };
  client.distributionPending = {
    findFirst: async (args: { where: { status: string; dealId?: string; contactId?: string } }) =>
      h.pendings.find(
        (p) =>
          p.status === args.where.status &&
          (args.where.dealId
            ? p.dealId === args.where.dealId
            : p.contactId === args.where.contactId),
      ) ?? null,
    create: async (args: { data: Omit<Pending, "id"> }) => {
      h.counts.pendingWrites++;
      const row = { ...args.data, id: `dp${h.pendings.length + 1}` };
      h.pendings.push(row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<Pending> }) => {
      h.counts.pendingWrites++;
      const row = h.pendings.find((p) => p.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    },
    updateMany: async (args: {
      where: { status?: string; contactId?: string; dealId?: string };
      data: Partial<Pending>;
    }) => {
      let count = 0;
      for (const p of h.pendings) {
        if (args.where.status && p.status !== args.where.status) continue;
        if (args.where.contactId && p.contactId !== args.where.contactId) continue;
        if (args.where.dealId && p.dealId !== args.where.dealId) continue;
        Object.assign(p, args.data);
        count++;
      }
      return { count };
    },
  };
  client.distributionLog = {
    findFirst: async () => null,
    create: async () => {
      h.counts.distributionLogs++;
      return { id: "log" };
    },
    update: async () => ({}),
  };
  client.$transaction = async (arg: unknown) =>
    (arg as (tx: unknown) => Promise<unknown>)(client);
  return { prisma: client };
});

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => h.currentOrg,
  getOrgIdOrNull: () => h.currentOrg,
  getRequestContext: () => undefined,
}));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: async (org: string, fn: () => unknown) => {
    h.currentOrg = org;
    return fn();
  },
}));
vi.mock("@/lib/channels/retired-whatsapp", () => ({
  isRetiredWhatsAppChannel: (ch: { name?: string | null } | null | undefined) =>
    ch?.name === "aposentado",
}));
vi.mock("@/services/ai/agent-vertical", () => ({
  resolveAgentVerticalForConversation: async () => ({ ops: {}, inboxPolicy: null }),
}));
vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: async () => h.orgs.get(h.currentOrg)?.widget ?? false,
}));
vi.mock("@/services/distribution/enabled", () => ({
  isDistributionEnabled: async () => h.orgs.get(h.currentOrg)?.enabled ?? true,
}));
vi.mock("@/services/distribution/responsibles", () => ({
  getDistributionResponsibles: async () => h.responsibles,
}));
vi.mock("@/services/distribution/assignee-eligibility", () => ({
  clearOwnershipForRedistribution: async () => undefined,
  isAssigneeCurrentlyEligible: async () => ({ eligible: true, isAi: false }),
  shouldClearOwnershipOnIneligible: () => false,
  shouldKeepAssigneeInAttendance: () => false,
}));
vi.mock("@/services/activity-log", () => ({
  logEvent: async () => {
    h.counts.activityEvents++;
  },
}));
vi.mock("@/services/conversation-events", () => ({
  createConversationEvent: async () => {
    h.counts.timelineEvents++;
    return { id: "ev" };
  },
}));
vi.mock("@/services/deals", () => ({
  assignDealOwner: async () => undefined,
  syncOwnershipForContact: async () => null,
  // Sem negócio aberto o motor propaga o dono direto para contato e conversas.
  propagateOwnerToContactAndChat: async (_tx: unknown, contactId: string, userId: string) => {
    for (const c of h.convs.values()) {
      if (c.contactId !== contactId) continue;
      h.counts.conversationWrites++;
      c.assignedToId = userId;
      c.updatedAt = new Date();
    }
  },
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: () => undefined,
}));
vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForConversation: async () => null,
}));
vi.mock("@/lib/channel-session", () => ({
  getConversationSession: async () => ({ active: false }),
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: async () => undefined,
}));

// Conta chamadas ao handoff sem trocar a implementação.
vi.mock("@/services/ai/department-handoff", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/ai/department-handoff")>();
  return {
    ...real,
    executeDepartmentHandoff: async (
      ...args: Parameters<typeof real.executeDepartmentHandoff>
    ) => {
      h.counts.handoffs++;
      return real.executeDepartmentHandoff(...args);
    },
  };
});

const { cache } = await import("@/lib/cache");
const { releaseConversationForHandoff } = await import("@/services/ai/handoff-release");
const {
  STUCK_RETRY_BASE_MS,
  distributeStuckInbound,
  resetStuckInboundStateForTests,
  stuckAttemptKey,
} = await import("@/services/ai/stuck-inbound-distribution");

const T0 = new Date("2026-10-05T12:00:00.000Z");
const MIN = 60_000;

function addConv(partial: Partial<Conv> & { id: string }): Conv {
  const n = h.convs.size + 1;
  const row: Conv = {
    number: n,
    organizationId: "org1",
    contactId: `ct_${partial.id}`,
    assignedToId: null,
    departmentId: null,
    status: "OPEN",
    hasHumanReply: false,
    // Mais antigo primeiro, na ordem em que foram criadas.
    lastInboundAt: new Date(T0.getTime() - 10 * 60 * MIN + n * 1000),
    lastOutboundAt: null,
    channelName: "principal",
    updatedAt: new Date(T0.getTime() - 10 * 60 * MIN),
    ...partial,
  };
  h.convs.set(row.id, row);
  return row;
}

function snapshot() {
  return { ...h.counts };
}
function delta(before: ReturnType<typeof snapshot>) {
  const after = snapshot();
  return Object.fromEntries(
    Object.entries(after).map(([k, v]) => [k, v - before[k as keyof typeof before]]),
  ) as ReturnType<typeof snapshot>;
}

/** Uma rodada da varredura no relógio atual; devolve o resultado e o que gravou. */
async function round(opts: { limit?: number } = {}) {
  const before = snapshot();
  const result = await distributeStuckInbound({ now: new Date(), ...opts });
  return { result, wrote: delta(before) };
}

const consultor: Responsible = {
  userId: "humano1",
  name: "Consultora Ana",
  eligible: true,
  blockedReasons: [],
  queueCount: 0,
  volume: 1,
  departments: [],
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.convs.clear();
  h.pendings.length = 0;
  h.users.clear();
  h.orgs.clear();
  h.departments.clear();
  h.responsibles = [];
  h.sql.length = 0;
  h.currentOrg = "org1";
  for (const k of Object.keys(h.counts) as (keyof typeof h.counts)[]) h.counts[k] = 0;
  h.users.set("ia1", { type: "AI", name: "Agente IA", agentActive: true });
  h.users.set("humano1", { type: "HUMAN", name: "Consultora Ana" });
  h.orgs.set("org1", { widget: true, enabled: true });
  resetStuckInboundStateForTests();
});

afterEach(async () => {
  for (const id of h.convs.keys()) await cache.del(stuckAttemptKey(id));
  vi.useRealTimers();
});

describe("varredura stuck-inbound — não regrava as mesmas conversas", () => {
  it("motor desligado: 2ª rodada sobre o mesmo estado = 0 gravações e 0 eventos", async () => {
    h.orgs.set("org1", { widget: true, enabled: false });
    addConv({ id: "ia_a", assignedToId: "ia1" });
    addConv({ id: "ia_b", assignedToId: "ia1" });
    // Entrada sem responsável: com o motor desligado o handoff não atribui
    // nem enfileira — era o que voltava a cada minuto.
    addConv({ id: "solta_a" });
    addConv({ id: "solta_b" });
    const updatedAtAntes = h.convs.get("solta_a")!.updatedAt.getTime();

    const r1 = await round();
    // Soltar a IA é mudança real: uma gravação por conversa presa, uma vez.
    expect(r1.wrote.conversationWrites).toBe(2);
    expect(r1.result.released).toBe(2);
    expect(r1.result.queued).toBe(0);
    expect(h.convs.get("ia_a")!.assignedToId).toBeNull();
    expect(h.convs.get("solta_a")!.updatedAt.getTime()).toBe(updatedAtAntes);

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(MIN);
      const r = await round();
      expect(r.wrote).toEqual({
        conversationWrites: 0,
        activityEvents: 0,
        timelineEvents: 0,
        distributionLogs: 0,
        pendingWrites: 0,
        handoffs: 0,
      });
      expect(r.result.candidates).toBe(0);
    }
    expect(h.convs.get("solta_a")!.updatedAt.getTime()).toBe(updatedAtAntes);
  });

  it("org sem o widget de distribuição: conversa sem responsável nunca é tocada", async () => {
    h.orgs.set("org1", { widget: false, enabled: true });
    addConv({ id: "solta_a" });
    addConv({ id: "solta_b" });

    for (let i = 0; i < 2; i++) {
      const r = await round();
      expect(r.wrote.conversationWrites).toBe(0);
      expect(r.wrote.handoffs).toBe(0);
      vi.advanceTimersByTime(MIN);
    }
  });

  it("sem consultor: enfileira uma vez, não repete, e distribui quando aparece consultor", async () => {
    addConv({ id: "c1", assignedToId: "ia1" });

    const r1 = await round();
    expect(r1.result.queued).toBe(1);
    expect(r1.wrote.conversationWrites).toBe(1); // soltou a IA
    expect(r1.wrote.activityEvents).toBe(1); // LEAD_DISTRIBUTION_FAILED, uma vez
    expect(h.pendings.filter((p) => p.status === "PENDING")).toHaveLength(1);

    // Na fila de espera: a consulta nem devolve a conversa.
    vi.advanceTimersByTime(MIN);
    const r2 = await round();
    expect(r2.wrote.conversationWrites).toBe(0);
    expect(r2.wrote.activityEvents).toBe(0);
    expect(r2.wrote.handoffs).toBe(0);

    // A drenagem limpou a pendência (ex.: conversa fora da fila ativa). Sem
    // a marca de tentativa a conversa voltava a cada minuto e criava outra
    // pendência + outro evento.
    for (const p of h.pendings) p.status = "RESOLVED";
    vi.advanceTimersByTime(MIN);
    const r3 = await round();
    expect(r3.result.skipped).toBe(1);
    expect(r3.wrote).toEqual({
      conversationWrites: 0,
      activityEvents: 0,
      timelineEvents: 0,
      distributionLogs: 0,
      pendingWrites: 0,
      handoffs: 0,
    });

    // Apareceu consultor: passada a espera, a rede de segurança entrega.
    h.responsibles = [consultor];
    vi.advanceTimersByTime(STUCK_RETRY_BASE_MS);
    const r4 = await round();
    expect(r4.result.distributed).toBe(1);
    expect(h.convs.get("c1")!.assignedToId).toBe("humano1");

    // Com humano responsável sai da varredura de vez.
    vi.advanceTimersByTime(MIN);
    const r5 = await round();
    expect(r5.result.candidates).toBe(0);
    expect(r5.wrote.conversationWrites).toBe(0);
  });

  it("conversa já sem responsável e já no departamento: enfileira sem regravar a conversa", async () => {
    h.departments.set("dep1", { id: "dep1", name: "Atendimento" });
    const c = addConv({ id: "c1", departmentId: "dep1" });
    const antes = c.updatedAt.getTime();

    const r1 = await round();
    expect(r1.result.queued).toBe(1);
    expect(r1.result.items[0]!.department).toBe("Atendimento");
    // Nem o handoff nem o motor regravam departamento/responsável iguais.
    expect(r1.wrote.conversationWrites).toBe(0);
    expect(c.updatedAt.getTime()).toBe(antes);
    expect(h.pendings.filter((p) => p.status === "PENDING")).toHaveLength(1);
  });

  it("ligar o motor reabre a Entrada na rodada seguinte, sem esperar", async () => {
    h.orgs.set("org1", { widget: true, enabled: false });
    addConv({ id: "solta_a" });
    expect((await round()).wrote.handoffs).toBe(0);

    h.orgs.set("org1", { widget: true, enabled: true });
    h.responsibles = [consultor];
    vi.advanceTimersByTime(MIN);
    const r = await round();
    expect(r.result.distributed).toBe(1);
    expect(h.convs.get("solta_a")!.assignedToId).toBe("humano1");
  });

  it("inbound novo invalida a marca de tentativa", async () => {
    h.orgs.set("org1", { widget: true, enabled: false });
    const c = addConv({ id: "c1", assignedToId: "ia1" });
    expect((await round()).result.released).toBe(1);

    // A IA reassumiu sem inbound novo (sync de dono): fica em espera.
    c.assignedToId = "ia1";
    vi.advanceTimersByTime(MIN);
    const parado = await round();
    expect(parado.result.skipped).toBe(1);
    expect(parado.wrote.conversationWrites).toBe(0);

    // O contato escreveu de novo e a IA seguiu muda por 15 min.
    c.lastInboundAt = new Date();
    vi.advanceTimersByTime(16 * MIN);
    const denovo = await round();
    expect(denovo.result.released).toBe(1);
    expect(denovo.wrote.conversationWrites).toBe(1);
  });

  it("linhas puladas não travam o lote: canal aposentado e conversas em espera", async () => {
    h.orgs.set("org1", { widget: true, enabled: false });
    // As 3 mais antigas são de canal aposentado — ocupavam o lote para sempre.
    addConv({ id: "ap1", assignedToId: "ia1", channelName: "aposentado" });
    addConv({ id: "ap2", assignedToId: "ia1", channelName: "aposentado" });
    addConv({ id: "ap3", assignedToId: "ia1", channelName: "aposentado" });
    const a = addConv({ id: "a", assignedToId: "ia1" });
    const b = addConv({ id: "b", assignedToId: "ia1" });
    addConv({ id: "c", assignedToId: "ia1" });
    addConv({ id: "d", assignedToId: "ia1" });

    const r1 = await round({ limit: 2 });
    expect(r1.result.released).toBe(2);
    expect(r1.result.skipped).toBe(3);
    expect(a.assignedToId).toBeNull();
    expect(b.assignedToId).toBeNull();
    expect(h.convs.get("ap1")!.assignedToId).toBe("ia1");

    // `a` e `b` voltam para a IA sem inbound novo: ficam em espera e NÃO
    // seguram a fila — `c` e `d` são tratadas na rodada seguinte.
    a.assignedToId = "ia1";
    b.assignedToId = "ia1";
    vi.advanceTimersByTime(MIN);
    const r2 = await round({ limit: 2 });
    expect(r2.result.released).toBe(2);
    expect(r2.result.skipped).toBe(5);
    expect(h.convs.get("c")!.assignedToId).toBeNull();
    expect(h.convs.get("d")!.assignedToId).toBeNull();
    expect(r2.wrote.conversationWrites).toBe(2);
  });

  it("presa na IA vem antes da Entrada sem responsável", async () => {
    addConv({ id: "solta_antiga" });
    addConv({ id: "ia_nova", assignedToId: "ia1" });

    const r = await round({ limit: 1 });
    expect(r.result.items).toHaveLength(1);
    expect(h.convs.get("ia_nova")!.assignedToId).toBeNull();
    expect(h.sql[0]).toContain('ORDER BY (c."assignedToId" IS NULL) ASC, c."lastInboundAt" ASC');
  });

  it("dry-run não grava nem marca tentativa", async () => {
    addConv({ id: "c1", assignedToId: "ia1" });
    const before = snapshot();
    const result = await distributeStuckInbound({ now: new Date(), apply: false });
    expect(result.items.map((i) => i.status)).toEqual(["listed"]);
    expect(delta(before).conversationWrites).toBe(0);
    expect(await cache.get(stuckAttemptKey("c1"))).toBeUndefined();
  });

  it("a consulta exclui org com motor parado, linhas já vistas e quem está na fila", async () => {
    await round();
    const sql = h.sql[0]!;
    expect(sql).toContain('AND NOT (c."organizationId" = ANY(?::text[]))');
    expect(sql).toContain("AND NOT (c.id = ANY(?::text[]))");
    expect(sql).toContain("dp.status = 'PENDING'");
  });
});

describe("releaseConversationForHandoff — só grava quando muda", () => {
  it("sem responsável e no mesmo departamento: não grava", async () => {
    const c = addConv({ id: "c1", departmentId: "dep1" });
    const antes = c.updatedAt.getTime();
    await expect(
      releaseConversationForHandoff({ conversationId: "c1", departmentId: "dep1" }),
    ).resolves.toEqual({ changed: false });
    await expect(
      releaseConversationForHandoff({ conversationId: "c1", departmentId: null }),
    ).resolves.toEqual({ changed: false });
    expect(h.counts.conversationWrites).toBe(0);
    expect(c.updatedAt.getTime()).toBe(antes);
  });

  it("com a IA como responsável: solta e grava uma vez", async () => {
    const c = addConv({ id: "c1", assignedToId: "ia1", departmentId: "dep1" });
    await expect(
      releaseConversationForHandoff({ conversationId: "c1", departmentId: "dep1" }),
    ).resolves.toEqual({ changed: true });
    expect(c.assignedToId).toBeNull();
    expect(h.counts.conversationWrites).toBe(1);
  });

  it("departamento diferente: grava o novo departamento", async () => {
    const c = addConv({ id: "c1", departmentId: "dep1" });
    await releaseConversationForHandoff({ conversationId: "c1", departmentId: "dep2" });
    expect(c.departmentId).toBe("dep2");
    expect(h.counts.conversationWrites).toBe(1);
  });
});
