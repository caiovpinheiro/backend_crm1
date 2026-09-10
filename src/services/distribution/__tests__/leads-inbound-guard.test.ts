/**
 * Guardas do modo leads no inbound (maybeDistributeNewInboundTicket):
 *
 * - Conversa em departamento com distributionMode="leads" NÃO é distribuída
 *   pelo smart (fica para o bloco mode="leads").
 * - Conversa marcada (routeMode="leads") sem dono: idem.
 * - Dono humano com assignedVia="leads" NÃO é reavaliado (offline/expediente
 *   não removem) — permanece.
 * - LIMITAÇÃO REGISTRADA (decisão de produto): primeira mensagem de conversa
 *   NOVA, ainda sem departamento, com as configurações globais atuais
 *   (autoOnInbound=true) → o smart distribui antes da automação rotear. O
 *   modo leads NÃO troca esse dono depois (DONO_PRESERVADO). Quem precisa da
 *   captura desde o primeiro inbound usa `distribution.autoOnInbound=false`
 *   e distribui tudo via blocos. Nada aqui desliga configs globais.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executeDistribution = vi.fn(async () => ({
  success: true,
  reason: "ASSIGNED",
  selectedUserId: "uSmart",
  selectedUserName: "Smart",
  evaluated: [],
}));
const keepHumanAfterAutomationClose = vi.fn(async () => null);
const tryAssignFirstAttendanceAi = vi.fn(async () => null);
const humanWasAssignedInThisConversation = vi.fn(async () => false);

vi.mock("@/lib/debug-log", () => ({
  debugInfo: vi.fn(),
  debugWarn: vi.fn(),
}));
vi.mock("@/lib/inbox-queue-membership", () => ({
  activeInboxQueueGuardWhere: () => ({ status: "OPEN" }),
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org1",
}));
vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: vi.fn(async () => true),
}));
vi.mock("@/services/ai/attendance-gate", () => ({
  isAiAttendanceEnabled: vi.fn(async () => false),
}));
vi.mock("@/services/ai/first-attendance", () => ({
  tryAssignFirstAttendanceAi: (...a: unknown[]) =>
    tryAssignFirstAttendanceAi(...a),
}));
vi.mock("@/services/ai/human-queue-policy", () => ({
  isHumanAttendanceWindowOpen: vi.fn(() => true),
}));
vi.mock("@/lib/channels/retired-whatsapp", () => ({
  isRetiredWhatsAppChannel: vi.fn(() => false),
}));
vi.mock("@/services/distribution/assignee-eligibility", () => ({
  clearOwnershipForRedistribution: vi.fn(async () => {}),
  isAssigneeCurrentlyEligible: vi.fn(async () => ({ eligible: true, isAi: false })),
  shouldClearOwnershipOnIneligible: vi.fn(() => false),
  shouldKeepAssigneeInAttendance: vi.fn(() => false),
}));
vi.mock("@/services/distribution/human-assignment-history", () => ({
  humanWasAssignedInThisConversation: (...a: unknown[]) =>
    humanWasAssignedInThisConversation(...a),
}));
vi.mock("@/services/distribution/return-after-close", () => ({
  keepHumanAfterAutomationClose: (...a: unknown[]) =>
    keepHumanAfterAutomationClose(...a),
}));
vi.mock("@/services/distribution/engine", () => ({
  executeDistribution: (...a: unknown[]) => executeDistribution(...a),
}));
vi.mock("@/services/distribution/enabled", () => ({
  isDistributionEnabled: vi.fn(async () => true),
}));
vi.mock("@/services/distribution/pending-shared", () => ({
  ensureConversationInWaitingQueue: vi.fn(async () => {}),
}));

// ── prisma fake ──
type ConvRow = {
  id: string;
  contactId: string;
  assignedToId: string | null;
  assignedVia: string | null;
  routeMode: string | null;
  departmentId: string | null;
  assigneeType: "HUMAN" | "AI";
};
let conversations: Map<string, ConvRow>;
let departmentModes: Map<string, string>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = conversations.get(where.id);
        if (!c) return null;
        return {
          id: c.id,
          contactId: c.contactId,
          assignedToId: c.assignedToId,
          assignedVia: c.assignedVia,
          routeMode: c.routeMode,
          departmentId: c.departmentId,
          channelRef: null,
          hasHumanReply: false,
          assignedTo: c.assignedToId ? { type: c.assigneeType } : null,
        };
      }),
      update: vi.fn(async () => ({})),
    },
    department: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        distributionMode: departmentModes.get(where.id) ?? "smart",
      })),
    },
    distributionPending: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import { maybeDistributeNewInboundTicket } from "../pending-inbound";

describe("maybeDistributeNewInboundTicket — guardas do modo leads", () => {
  beforeEach(() => {
    conversations = new Map();
    departmentModes = new Map();
    vi.clearAllMocks();
  });

  it("conversa NOVA sem departamento: smart distribui (limitação registrada — leads não troca esse dono depois)", async () => {
    conversations.set("c1", {
      id: "c1",
      contactId: "ct1",
      assignedToId: null,
      assignedVia: null,
      routeMode: null,
      departmentId: null, // ainda sem departamento — ordem real do fluxo
      assigneeType: "HUMAN",
    });

    await maybeDistributeNewInboundTicket({
      conversationId: "c1",
      contactId: "ct1",
      assignedToId: null,
    });

    // Comportamento atual preservado: o smart distribui no inbound. Se a
    // automação rotear depois para um depto leads e o bloco leads executar,
    // o dono é preservado (DONO_PRESERVADO) — nunca trocado.
    expect(executeDistribution).toHaveBeenCalledTimes(1);
  });

  it("conversa em departamento leads: smart NÃO distribui", async () => {
    departmentModes.set("dep1", "leads");
    conversations.set("c1", {
      id: "c1",
      contactId: "ct1",
      assignedToId: null,
      assignedVia: null,
      routeMode: null,
      departmentId: "dep1",
      assigneeType: "HUMAN",
    });

    await maybeDistributeNewInboundTicket({
      conversationId: "c1",
      contactId: "ct1",
      assignedToId: null,
    });

    expect(executeDistribution).not.toHaveBeenCalled();
  });

  it("conversa marcada (routeMode=leads) sem dono: smart NÃO distribui", async () => {
    conversations.set("c1", {
      id: "c1",
      contactId: "ct1",
      assignedToId: null,
      assignedVia: null,
      routeMode: "leads",
      departmentId: null,
      assigneeType: "HUMAN",
    });

    await maybeDistributeNewInboundTicket({
      conversationId: "c1",
      contactId: "ct1",
      assignedToId: null,
    });

    expect(executeDistribution).not.toHaveBeenCalled();
  });

  it("dono humano com assignedVia=leads: não reavalia nem remove (offline/expediente)", async () => {
    conversations.set("c1", {
      id: "c1",
      contactId: "ct1",
      assignedToId: "uLeads",
      assignedVia: "leads",
      routeMode: null,
      departmentId: null,
      assigneeType: "HUMAN",
    });

    await maybeDistributeNewInboundTicket({
      conversationId: "c1",
      contactId: "ct1",
      assignedToId: "uLeads",
    });

    expect(executeDistribution).not.toHaveBeenCalled();
    // Nenhuma limpeza de ownership foi chamada.
    const { clearOwnershipForRedistribution } = await import(
      "@/services/distribution/assignee-eligibility"
    );
    expect(clearOwnershipForRedistribution).not.toHaveBeenCalled();
  });

  it("dono humano smart (assignedVia!=leads) NÃO é interceptado pela guarda leads", async () => {
    // Humano atribuído NESTA conversa → o fluxo atual o mantém (sem motor).
    humanWasAssignedInThisConversation.mockResolvedValue(true);
    conversations.set("c1", {
      id: "c1",
      contactId: "ct1",
      assignedToId: "uSmart",
      assignedVia: "smart",
      routeMode: null,
      departmentId: null,
      assigneeType: "HUMAN",
    });

    await maybeDistributeNewInboundTicket({
      conversationId: "c1",
      contactId: "ct1",
      assignedToId: "uSmart",
    });

    // A guarda leads não interceptou: a reavaliação normal do smart rodou
    // (isAssigneeCurrentlyEligible foi consultado) e manteve o dono.
    const { isAssigneeCurrentlyEligible } = await import(
      "@/services/distribution/assignee-eligibility"
    );
    expect(isAssigneeCurrentlyEligible).toHaveBeenCalled();
    expect(executeDistribution).not.toHaveBeenCalled();
  });
});
