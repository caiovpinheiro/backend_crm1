/**
 * Atendimento de quem chega identificado (§9.12): cada destino, a alternativa
 * de cada um e a precedência sobre responsável atual, 1º atendimento de IA e
 * Regra 0. Distribuição e IA mockadas: o que importa aqui é a decisão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    conv: null as Record<string, unknown> | null,
    updates: [] as Record<string, unknown>[],
    people: new Map<string, { id: string; name: string }>(),
    agents: new Map<string, { id: string; name: string; aiAgentConfig: { simpleConfig: unknown } }>(),
    departments: new Map<string, { id: string; distributionMode: string }>(),
    contactOwner: null as string | null,
    motorOn: true,
    aiEnabled: true,
    allowed: true,
    orgMode: "smart",
    unavailable: new Set<string>(),
    eligibleInDept: true,
    maybeDistribute: vi.fn(async (_a: unknown) => {}),
    executeDistribution: vi.fn(async (_a: unknown) => ({ success: true })),
    executeLeads: vi.fn(async (_a: unknown) => ({ success: true })),
    clearOwnership: vi.fn(async (_a: unknown) => {}),
    logChanges: vi.fn(async (_a: unknown) => {}),
    propagate: vi.fn(async (..._a: unknown[]) => []),
    resolvePostClose: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => m.logger }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/lib/realtime-events", () => ({ publishConversationUpdated: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const conversation = {
    findUnique: async () => (m.conv ? { ...m.conv } : null),
    update: async ({ data }: { data: Record<string, unknown> }) => {
      m.updates.push(data);
      Object.assign(m.conv ?? {}, data);
      return { id: "c-1" };
    },
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      m.updates.push(data);
      Object.assign(m.conv ?? {}, data);
      return { count: 1 };
    },
  };
  const client = {
    conversation,
    contact: {
      findUnique: async () => ({ assignedToId: m.contactOwner, phone: null }),
      update: async () => ({}),
    },
    deal: { updateMany: async () => ({ count: 1 }) },
    distributionPending: { updateMany: async () => ({ count: 0 }) },
    department: {
      findFirst: async ({ where }: { where: { id: string } }) => m.departments.get(where.id) ?? null,
    },
    user: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string; type: string } }) => {
        if (where.organizationId !== "org-1") return null;
        return where.type === "AI" ? m.agents.get(where.id) ?? null : m.people.get(where.id) ?? null;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { prisma: client };
});
vi.mock("@/services/ai/attendance-gate", () => ({ isAiAttendanceEnabled: async () => m.aiEnabled }));
vi.mock("@/services/ai/phone-allowlist", () => ({ isContactAllowedForAi: async () => m.allowed }));
vi.mock("@/services/ai-v2/agent-resolver", () => ({
  pickAgentForConversation: (agents: unknown[]) => agents[0] ?? null,
}));
vi.mock("@/services/deals", () => ({
  logConversationAssigneeChanges: m.logChanges,
  propagateOwnerToContactAndChat: m.propagate,
}));
vi.mock("@/services/distribution/assignee-eligibility", () => ({
  isAssigneeCurrentlyEligible: async (id: string) =>
    m.unavailable.has(id)
      ? { eligible: false, isAi: false, reason: "OFFLINE", blockedReasons: ["OFFLINE"] }
      : { eligible: true, isAi: false },
  shouldClearOwnershipOnIneligible: () => true,
  clearOwnershipForRedistribution: m.clearOwnership,
}));
vi.mock("@/services/distribution/enabled", () => ({ isDistributionEnabled: async () => m.motorOn }));
vi.mock("@/services/distribution/engine", () => ({ executeDistribution: m.executeDistribution }));
vi.mock("@/services/distribution/leads/engine", () => ({ executeLeadsDistribution: m.executeLeads }));
vi.mock("@/services/distribution/mode", () => ({ getOrgDistributionModeFresh: async () => m.orgMode }));
vi.mock("@/services/distribution/pending-inbound", () => ({
  maybeDistributeNewInboundTicket: m.maybeDistribute,
}));
vi.mock("@/services/distribution/responsibles", () => ({
  getDistributionResponsibles: async () => (m.eligibleInDept ? [{ eligible: true }] : [{ eligible: false }]),
}));
vi.mock("@/services/organization-widgets", () => ({ hasOrganizationWidget: async () => m.motorOn }));
vi.mock("@/services/post-close-return", () => ({ resolvePostCloseInbound: m.resolvePostClose }));

import { applyWebchatRouting } from "@/lib/webchat/routing";
import {
  defaultWebchatRoutingConfig,
  type WebchatRoutingConfig,
  type WebchatRoutingTarget,
} from "@/lib/webchat/v2-config";

const USER: WebchatRoutingTarget = { type: "user", id: "u-1" };
const DEPT: WebchatRoutingTarget = { type: "department", id: "d-1" };
const AGENT: WebchatRoutingTarget = { type: "ai_agent", id: "a-1" };

function routing(p: Partial<WebchatRoutingConfig>): WebchatRoutingConfig {
  return { ...defaultWebchatRoutingConfig(), keepCurrentOwner: false, ...p };
}

function run(p: Partial<WebchatRoutingConfig>, force?: boolean) {
  return applyWebchatRouting({ conversationId: "c-1", contactId: "ct-1", routing: routing(p), force });
}

const merged = () => Object.assign({}, ...m.updates) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  m.conv = {
    id: "c-1",
    status: "OPEN",
    assignedToId: null,
    assignedVia: null,
    hasHumanReply: false,
    priorityAt: null,
    routedAt: null,
    departmentId: null,
    assignedTo: null,
  };
  m.updates = [];
  m.people = new Map([["u-1", { id: "u-1", name: "Pessoa" }], ["u-2", { id: "u-2", name: "Atual" }]]);
  m.agents = new Map([["a-1", { id: "a-1", name: "Agente", aiAgentConfig: { simpleConfig: {} } }]]);
  m.departments = new Map([["d-1", { id: "d-1", distributionMode: "smart" }]]);
  m.contactOwner = null;
  m.motorOn = true;
  m.aiEnabled = true;
  m.allowed = true;
  m.orgMode = "smart";
  m.unavailable = new Set();
  m.eligibleInDept = true;
});

describe("destino pessoa", () => {
  it("disponível: fica com ela, protegida da reavaliação", async () => {
    expect(await run({ destination: USER })).toBe(true);
    expect(merged()).toMatchObject({ assignedToId: "u-1", assignedVia: "webchat_routing", routeMode: null });
    expect(merged().routedAt).toBeInstanceOf(Date);
    expect(m.maybeDistribute).not.toHaveBeenCalled();
  });

  it("offline: vai para a alternativa", async () => {
    m.unavailable.add("u-1");
    await run({ destination: USER, fallback: AGENT });
    expect(merged()).toMatchObject({ assignedToId: "a-1" });
  });

  it("removida: vai para a alternativa", async () => {
    await run({ destination: { type: "user", id: "apagada" }, fallback: DEPT });
    expect(merged()).toMatchObject({ departmentId: "d-1", routeMode: "human" });
  });

  it("indisponível, sem alternativa: distribuição convencional", async () => {
    m.unavailable.add("u-1");
    expect(await run({ destination: USER })).toBe(true);
    expect(m.maybeDistribute).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-1", contactId: "ct-1" }),
    );
  });

  it("sem o motor não há presença: só removida conta", async () => {
    m.motorOn = false;
    m.unavailable.add("u-1");
    await run({ destination: USER });
    expect(merged()).toMatchObject({ assignedToId: "u-1" });
  });
});

describe("destino departamento", () => {
  it("com gente disponível: pede a distribuição no departamento", async () => {
    await run({ destination: DEPT });
    expect(merged()).toMatchObject({ departmentId: "d-1", routeMode: "human" });
    expect(m.executeDistribution).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSource: "WEBCHAT_ROUTING",
        departmentIds: ["d-1"],
        allowOrgWideFallback: false,
      }),
    );
  });

  it("sem ninguém: vai para a alternativa, sem marcar o departamento", async () => {
    m.eligibleInDept = false;
    await run({ destination: DEPT, fallback: USER });
    expect(merged()).toMatchObject({ assignedToId: "u-1" });
    expect(merged().departmentId).toBeUndefined();
  });

  it("sem ninguém, alternativa distribuição: espera na fila do departamento", async () => {
    m.eligibleInDept = false;
    await run({ destination: DEPT });
    expect(merged()).toMatchObject({ departmentId: "d-1", routeMode: "human" });
    expect(m.executeDistribution).toHaveBeenCalledWith(
      expect.objectContaining({ departmentIds: ["d-1"], triggerSource: "WEBCHAT_ROUTING" }),
    );
    expect(m.maybeDistribute).not.toHaveBeenCalled();
  });

  it("removido: cai na alternativa", async () => {
    await run({ destination: { type: "department", id: "apagado" }, fallback: AGENT });
    expect(merged()).toMatchObject({ assignedToId: "a-1" });
  });

  it("sem o motor, o próprio departamento é o destino", async () => {
    m.motorOn = false;
    await run({ destination: DEPT });
    expect(merged()).toMatchObject({ departmentId: "d-1", routeMode: "human" });
    expect(m.executeDistribution).not.toHaveBeenCalled();
  });

  it("departamento por leads usa o rodízio de leads", async () => {
    m.departments.set("d-1", { id: "d-1", distributionMode: "leads" });
    await run({ destination: DEPT });
    expect(m.executeLeads).toHaveBeenCalled();
    expect(m.executeDistribution).not.toHaveBeenCalled();
  });
});

describe("destino agente de IA", () => {
  it("ativo: assume o ticket", async () => {
    await run({ destination: AGENT });
    expect(merged()).toMatchObject({ assignedToId: "a-1", aiGreetedAt: null });
    expect(m.maybeDistribute).not.toHaveBeenCalled();
  });

  it.each([
    ["atendimento por IA desligado", () => (m.aiEnabled = false)],
    ["contato fora da lista de teste", () => (m.allowed = false)],
    ["agente apagado ou inativo", () => m.agents.clear()],
  ])("%s: vai para a alternativa", async (_n, setup) => {
    setup();
    await run({ destination: AGENT, fallback: USER });
    expect(merged()).toMatchObject({ assignedToId: "u-1" });
  });
});

describe("distribuição e prioridade", () => {
  it("fila normal: exatamente as regras de hoje", async () => {
    await run({});
    expect(m.maybeDistribute).toHaveBeenCalledTimes(1);
    expect(m.executeDistribution).not.toHaveBeenCalled();
    expect(merged().priorityAt).toBeUndefined();
    expect(merged().routeMode).toBeUndefined();
  });

  it("prioridade alta: marca, pede a distribuição e tira a IA do caminho", async () => {
    await run({ priority: "high" });
    expect(merged().priorityAt).toBeInstanceOf(Date);
    expect(merged()).toMatchObject({ routeMode: "human" });
    expect(m.executeDistribution).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "WEBCHAT_ROUTING" }),
    );
    expect(m.maybeDistribute).not.toHaveBeenCalled();
  });

  it("prioridade alta com distribuição desligada: fica na Entrada, marcada", async () => {
    m.motorOn = false;
    await run({ priority: "high" });
    expect(merged().priorityAt).toBeInstanceOf(Date);
    expect(m.executeDistribution).not.toHaveBeenCalled();
  });

  it("prioridade alta vale também com destino", async () => {
    await run({ priority: "high", destination: AGENT });
    expect(merged().priorityAt).toBeInstanceOf(Date);
    expect(merged()).toMatchObject({ assignedToId: "a-1" });
  });

  it("não remarca quem já é prioritária", async () => {
    const at = new Date("2026-01-01");
    m.conv!.priorityAt = at;
    await run({ priority: "high" });
    expect(merged().priorityAt ?? at).toBe(at);
  });
});

describe("precedência", () => {
  it("pessoa que já respondeu: nada muda, nem a prioridade", async () => {
    m.conv!.hasHumanReply = true;
    m.conv!.assignedToId = "u-2";
    expect(await run({ priority: "high", destination: USER })).toBe(false);
    expect(m.updates).toEqual([]);
  });

  it("responsável atual disponível fica, com keepCurrentOwner", async () => {
    m.contactOwner = "u-2";
    await run({ destination: USER, keepCurrentOwner: true });
    expect(merged()).toMatchObject({ assignedToId: "u-2", assignedVia: "webchat_routing" });
    expect(m.maybeDistribute).not.toHaveBeenCalled();
  });

  it("responsável atual indisponível vai para o destino", async () => {
    m.contactOwner = "u-2";
    m.unavailable.add("u-2");
    await run({ destination: USER, keepCurrentOwner: true });
    expect(merged()).toMatchObject({ assignedToId: "u-1" });
  });

  it("responsável atual agente de IA fica, com keepCurrentOwner", async () => {
    m.contactOwner = "a-1";
    await run({ destination: USER, keepCurrentOwner: true });
    expect(merged()).toMatchObject({ assignedToId: "a-1" });
  });

  it("sem keepCurrentOwner, o destino vence o responsável atual", async () => {
    m.conv!.assignedToId = "u-2";
    m.conv!.assignedTo = { type: "HUMAN", name: "Atual" };
    await run({ destination: USER });
    expect(merged()).toMatchObject({ assignedToId: "u-1" });
    expect(m.logChanges).toHaveBeenCalled();
  });

  it("destino vence o 1º atendimento de IA, que só existe na distribuição convencional", async () => {
    await run({ destination: DEPT });
    expect(m.maybeDistribute).not.toHaveBeenCalled();
    expect(merged()).toMatchObject({ routeMode: "human" });
  });

  it("Regra 0 não é consultada: o destino configurado vale", async () => {
    await run({ destination: AGENT });
    expect(m.resolvePostClose).not.toHaveBeenCalled();
    expect(merged()).toMatchObject({ assignedToId: "a-1" });
  });
});

describe("uma vez por ticket", () => {
  beforeEach(() => {
    m.conv!.routedAt = new Date("2026-01-01");
  });

  it("não reaplica por cima de transferência", async () => {
    m.conv!.assignedToId = "u-2";
    m.conv!.assignedVia = "smart";
    m.conv!.assignedTo = { type: "HUMAN", name: "Outra" };
    expect(await run({ destination: USER })).toBe(false);
    expect(m.updates).toEqual([]);
  });

  it("pessoa escolhida aqui que ficou indisponível: segue para a próxima opção", async () => {
    m.conv!.assignedToId = "u-1";
    m.conv!.assignedVia = "webchat_routing";
    m.conv!.assignedTo = { type: "HUMAN", name: "Pessoa" };
    m.unavailable.add("u-1");
    expect(await run({ destination: USER, fallback: AGENT })).toBe(true);
    expect(m.clearOwnership).toHaveBeenCalled();
    expect(merged()).toMatchObject({ assignedToId: "a-1" });
  });

  it("regra do S2S com destino vale mesmo em ticket já roteado", async () => {
    expect(await run({ destination: USER }, true)).toBe(true);
    expect(merged()).toMatchObject({ assignedToId: "u-1" });
  });
});

describe("robustez", () => {
  it("conversa encerrada ou sumida: não faz nada", async () => {
    m.conv!.status = "RESOLVED";
    expect(await run({ destination: USER })).toBe(false);
    m.conv = null;
    expect(await run({ destination: USER })).toBe(false);
  });

  it("falha nunca sobe: quem chama segue o caminho de sempre", async () => {
    m.propagate.mockRejectedValueOnce(new Error("banco"));
    expect(await run({ destination: USER })).toBe(false);
  });
});
