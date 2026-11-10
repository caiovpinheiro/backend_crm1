/**
 * Cenário "Acadêmico": o lead fecha no comercial (etapa Ganho ou Aceite) e
 * uma automação distribui a conversa para um consultor do Acadêmico.
 *
 * Diferente de `keep-deal-owner-engine.test.ts`, aqui a regra de manter o
 * dono (`resolveKeepDealOwner`) roda DE VERDADE contra um "banco" em
 * memória. Só a gravação final (`assignConversationOnly` /
 * `assignDealOwner`) é observada. O config do passo passa pelo mesmo
 * `readStepKeepDealOwner` que o executor usa.
 *
 * O que importa para o painel de vendas: o dono do negócio continua o
 * consultor comercial.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { readStepKeepDealOwner, readStepReassign } from "@/lib/automation-workflow";

const DEPT = "dept_academico";
const CONV = "conv_aluno";
const CONTACT = "ct_aluno";
const COMERCIAL = "consultor_comercial";
const ACADEMICO = "consultor_academico";

type FakeDeal = {
  id: string;
  contactId: string;
  status: "OPEN" | "WON" | "LOST";
  ownerId: string | null;
  owner: { type: "HUMAN" | "AI" } | null;
};
let deals: FakeDeal[] = [];
let deptKeepsOwner = false;
// Aba Distribuição (produção do comercial): Por Leads ativo, Inteligente desligado.
let smartSwitchOn = true;
let orgMode = "smart";
let deptMode = "smart";
// Responsável atual da conversa (ex.: o consultor comercial que vendeu).
let convAssignee: string | null = null;

/** Avalia o `where` que `contactHasHumanDealOwner` monta. */
function matches(d: FakeDeal, where: Record<string, unknown>): boolean {
  if ("ownerId" in where && d.ownerId === null) return false;
  if ("owner" in where && d.owner?.type !== (where.owner as { type: string }).type) return false;
  if ("id" in where && d.id !== where.id) return false;
  if ("contactId" in where && d.contactId !== where.contactId) return false;
  if ("status" in where && d.status !== where.status) return false;
  if (Array.isArray(where.OR)) {
    return (where.OR as Record<string, unknown>[]).some((w) => matches(d, w));
  }
  return true;
}

const assignDealOwner = vi.fn(async (..._a: unknown[]) => undefined);
const assignConversationOnly = vi.fn(async (..._a: unknown[]) => null);
const getDistributionResponsibles = vi.fn();
const tx = {
  conversation: { update: vi.fn(async () => ({ id: CONV })) },
  contact: { update: vi.fn(async () => ({})) },
  deal: { updateMany: vi.fn(async () => ({ count: 1 })) },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async (args: { select?: Record<string, unknown> }) => {
        const keys = Object.keys(args.select ?? {});
        if (keys.length === 1 && keys[0] === "channelRef") return { channelRef: null };
        return {
          id: CONV,
          contactId: CONTACT,
          departmentId: DEPT,
          assignedToId: convAssignee,
          assignedTo: convAssignee ? { type: "HUMAN", name: "Comercial" } : null,
          channel: "WHATSAPP",
          channelId: null,
          lastInboundAt: null,
        };
      }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: CONV })),
    },
    department: {
      findUnique: vi.fn(async () => ({
        id: DEPT,
        distributionEnabled: true,
        distributionMode: deptMode,
        keepDealOwner: deptKeepsOwner,
      })),
      findMany: vi.fn(async () => [{ id: DEPT, distributionMode: deptMode }]),
    },
    deal: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
        deals.find((d) => matches(d, args.where)) ?? null,
      ),
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        deals.filter((d) => matches(d, args.where)).map((d) => ({ id: d.id })),
      ),
      findUnique: vi.fn(async () => ({ contactId: CONTACT, ownerId: COMERCIAL })),
    },
    distributionLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "log" })),
      update: vi.fn(async () => ({})),
    },
    distributionPending: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    activityEvent: { findFirst: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ type: "HUMAN" })) },
    distributionResponsible: { upsert: vi.fn(async () => ({})) },
    contact: { findUnique: vi.fn(async () => ({ assignedTo: { type: "HUMAN" } })) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) =>
      typeof fn === "function" ? fn(tx) : undefined,
    ),
  },
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: async () => false,
  getOrgSetting: async () => null,
  getOrgSettingOrDefault: async (key: string, def: string) =>
    key === "distribution.mode" ? orgMode : def,
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org_teste",
  getRequestContext: () => undefined,
}));
vi.mock("@/services/organization-widgets", () => ({ hasOrganizationWidget: async () => true }));
vi.mock("../enabled", () => ({ isDistributionEnabled: async () => smartSwitchOn }));
vi.mock("../responsibles", () => ({
  getDistributionResponsibles: (...a: unknown[]) => getDistributionResponsibles(...a),
}));
vi.mock("@/services/activity-log", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: () => undefined,
}));
vi.mock("@/lib/channels/retired-whatsapp", () => ({ isRetiredWhatsAppChannel: () => false }));
vi.mock("@/services/deals", () => ({
  assignDealOwner: (...a: unknown[]) => assignDealOwner(...a),
  propagateOwnerToContactAndChat: async () => undefined,
  syncOwnershipForContact: async () => null,
  assignOwnerToContactClusterTx: async () => ({ dealIds: [], pipelineIds: [] }),
  invalidateBoardsForPipelines: async () => undefined,
  logConversationAssigneeChanges: async () => undefined,
}));
vi.mock("@/lib/channel-session", () => ({ getConversationSession: async () => ({ active: false }) }));
// Regra REAL; só a gravação "somente a conversa" é observada.
vi.mock("../deal-owner-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deal-owner-scope")>()),
  assignConversationOnly: (...a: unknown[]) => assignConversationOnly(...a),
}));
// O consultor que vendeu já respondeu o cliente (atendimento humano em curso).
let consultorReplied = false;
vi.mock("@/services/attendance-guards", () => ({
  getHumanAttendanceForConversation: async () =>
    consultorReplied ? { hasHumanReply: true } : null,
}));

const { executeDistribution } = await import("../engine");

/** O que o executor faz no passo "Executar distribuição" (modo Inteligente). */
function runStep(stepConfig: Record<string, unknown>, dealId: string) {
  const mode = stepConfig.mode;
  return executeDistribution({
    explicitStepMode: mode === "smart",
    dealId,
    contactId: CONTACT,
    conversationId: CONV,
    triggerSource: "AUTOMATION",
    departmentIds: [DEPT],
    allowOrgWideFallback: false,
    keepDealOwner: readStepKeepDealOwner(stepConfig),
    reassign: readStepReassign(stepConfig),
    reassignOnlyIfEligible: true,
  });
}

function deal(status: FakeDeal["status"], owner: "HUMAN" | "AI" | null = "HUMAN"): FakeDeal {
  return {
    id: `deal_${status.toLowerCase()}`,
    contactId: CONTACT,
    status,
    ownerId: owner ? (owner === "HUMAN" ? COMERCIAL : "agente_ia") : null,
    owner: owner ? { type: owner } : null,
  };
}

describe("Cenário Acadêmico: lead fechou no comercial → conversa para o acadêmico", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deptKeepsOwner = false;
    smartSwitchOn = true;
    orgMode = "smart";
    deptMode = "smart";
    convAssignee = null;
    consultorReplied = false;
    getDistributionResponsibles.mockResolvedValue([
      { userId: ACADEMICO, name: "Acadêmico", eligible: true, blockedReasons: [], queueCount: 0, volume: 1 },
    ]);
  });

  it("Ganho (WON) + 'Somente a conversa': acadêmico pega a conversa, venda segue do comercial", async () => {
    deals = [deal("WON")];
    const r = await runStep({ ownershipScope: "conversation_only" }, "deal_won");

    expect(r.success).toBe(true);
    expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: ACADEMICO });
    expect(assignDealOwner).not.toHaveBeenCalled();
  });

  it("Aceite (OPEN) + 'Somente a conversa': mesmo resultado", async () => {
    deals = [deal("OPEN")];
    await runStep({ ownershipScope: "conversation_only" }, "deal_open");

    expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: ACADEMICO });
    expect(assignDealOwner).not.toHaveBeenCalled();
  });

  it("Ganho + 'Seguir regra do departamento' com o Acadêmico mantendo o dono: venda segue do comercial", async () => {
    deals = [deal("WON")];
    deptKeepsOwner = true;
    await runStep({}, "deal_won");

    expect(assignDealOwner).not.toHaveBeenCalled();
  });

  it("Ganho + 'Conversa e negócio': o dono da venda passa para o acadêmico (por escolha)", async () => {
    deals = [deal("WON")];
    await runStep({ ownershipScope: "conversation_and_deal" }, "deal_won");

    expect(assignDealOwner).toHaveBeenCalledWith("deal_won", ACADEMICO);
    expect(assignConversationOnly).not.toHaveBeenCalled();
  });

  it("negócio ganho com IA como dono + 'Somente a conversa': o negócio não vai para o acadêmico", async () => {
    deals = [deal("WON", "AI")];
    await runStep({ ownershipScope: "conversation_only" }, "deal_won");

    expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: ACADEMICO });
    expect(assignDealOwner).not.toHaveBeenCalled();
  });

  describe("aba Distribuição em Por Leads (comercial) e passo em Inteligente", () => {
    beforeEach(() => {
      orgMode = "leads";
      smartSwitchOn = false;
      deptMode = "leads";
      deals = [deal("WON")];
    });

    it("passo com modo Inteligente explícito distribui mesmo assim", async () => {
      const r = await runStep({ mode: "smart", ownershipScope: "conversation_only" }, "deal_won");

      expect(r.success).toBe(true);
      expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: ACADEMICO });
      expect(assignDealOwner).not.toHaveBeenCalled();
    });

    it("passo sem modo salvo continua seguindo a aba (desligado = não distribui)", async () => {
      const r = await runStep({ ownershipScope: "conversation_only" }, "deal_won");

      expect(r.success).toBe(false);
      expect(r.reason).toBe("DISTRIBUTION_DISABLED");
    });

    it("org em Inteligente com o interruptor desligado: o freio vale para o passo Inteligente", async () => {
      orgMode = "smart";
      const r = await runStep({ mode: "smart", ownershipScope: "conversation_only" }, "deal_won");

      expect(r.success).toBe(false);
      expect(r.reason).toBe("DISTRIBUTION_DISABLED");
    });
  });

  describe("conversa já com o consultor comercial (a venda dele)", () => {
    const STEP = { mode: "smart", ownershipScope: "conversation_only" };

    beforeEach(() => {
      deals = [deal("WON")];
      convAssignee = COMERCIAL;
      consultorReplied = true;
    });

    it("'Tirar e redistribuir': sai do consultor e vai para o acadêmico; a venda segue dele", async () => {
      const r = await runStep({ ...STEP, ifAssigned: "reassign" }, "deal_won");

      expect(r.success).toBe(true);
      expect(tx.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { assignedToId: null } }),
      );
      expect(tx.contact.update).not.toHaveBeenCalled();
      expect(tx.deal.updateMany).not.toHaveBeenCalled();
      expect(assignConversationOnly).toHaveBeenCalledWith({ conversationId: CONV, userId: ACADEMICO });
      expect(assignDealOwner).not.toHaveBeenCalled();
    });

    it("'Tirar e redistribuir' sem acadêmico disponível: não tira do consultor", async () => {
      getDistributionResponsibles.mockResolvedValue([
        { userId: ACADEMICO, name: "Acadêmico", eligible: false, blockedReasons: ["OFFLINE"], queueCount: 0, volume: 1 },
      ]);
      const r = await runStep({ ...STEP, ifAssigned: "reassign" }, "deal_won");

      expect(r.success).toBe(false);
      expect(r.reason).toBe("NO_ELIGIBLE_RESPONSIBLE");
      expect(tx.conversation.update).not.toHaveBeenCalled();
      expect(assignConversationOnly).not.toHaveBeenCalled();
    });

    it("'Manter com quem está atendendo' (padrão): não mexe na conversa do consultor", async () => {
      await runStep(STEP, "deal_won");

      expect(tx.conversation.update).not.toHaveBeenCalled();
      expect(assignConversationOnly).not.toHaveBeenCalled();
    });
  });
});
