import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationFindUnique: vi.fn(),
  conversationUpdateMany: vi.fn(),
  userFindFirst: vi.fn(),
  stateFindUnique: vi.fn(),
  attendanceEnabled: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    conversation: { findUnique: mocks.conversationFindUnique, updateMany: mocks.conversationUpdateMany },
    user: {
      findFirst: mocks.userFindFirst,
      findMany: async (args: unknown) => {
        const r = await mocks.userFindFirst(args);
        return Array.isArray(r) ? r : r ? [r] : [];
      },
    },
    aISimpleConversationState: { findUnique: mocks.stateFindUnique },
  },
}));

// Mesmas regras de `phone-allowlist` (o módulo real importa org-settings/prisma).
vi.mock("@/services/ai/phone-allowlist", () => {
  const normalizePhoneDigits = (raw: string | null | undefined) => {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
    return d;
  };
  return {
    normalizePhoneDigits,
    phoneMatchesAllowlist: (phone: string, allow: Set<string>) => {
      const n = normalizePhoneDigits(phone);
      return [...allow].some((p) => p && (n === p || n.endsWith(p) || p.endsWith(n)));
    },
  };
});

vi.mock("@/services/ai/attendance-gate", () => ({
  isAiAttendanceEnabled: mocks.attendanceEnabled,
}));

import { resolveV2AgentForConversation } from "../agent-resolver";

const UNASSIGNED = {
  id: "conv-1",
  organizationId: "org-1",
  assignedToId: null,
  closedAt: null,
  contact: { phone: "5511988887777" },
  assignedTo: null,
};

function agent(simpleConfig: Record<string, unknown> = {}) {
  return { id: "ai-user-1", aiAgentConfig: { id: "agent-1", simpleConfig } };
}

describe("resolveV2AgentForConversation — atribuição automática", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindUnique.mockResolvedValue(UNASSIGNED);
    mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.userFindFirst.mockResolvedValue(agent());
    mocks.stateFindUnique.mockResolvedValue(null);
    mocks.attendanceEnabled.mockResolvedValue(true);
  });

  it("conversa nova sem responsável vai para o agente v2", async () => {
    const r = await resolveV2AgentForConversation("conv-1");
    expect(r).toMatchObject({ userId: "ai-user-1", agentConfigId: "agent-1", wasAssigned: true });
    expect(mocks.conversationUpdateMany).toHaveBeenCalled();
  });

  it("conversa transferida para humano (owner=pessoa) e ainda aberta não volta para a IA", async () => {
    mocks.stateFindUnique.mockResolvedValue({ owner: "pessoa", updatedAt: new Date() });

    const r = await resolveV2AgentForConversation("conv-1");

    expect(r).toBeNull();
    expect(mocks.conversationUpdateMany).not.toHaveBeenCalled();
  });

  it("encerrada depois do handoff: pode voltar para a IA", async () => {
    const handoffAt = new Date(Date.now() - 60_000);
    mocks.stateFindUnique.mockResolvedValue({ owner: "pessoa", updatedAt: handoffAt });
    mocks.conversationFindUnique.mockResolvedValue({ ...UNASSIGNED, closedAt: new Date() });

    const r = await resolveV2AgentForConversation("conv-1");

    expect(r?.wasAssigned).toBe(true);
  });

  it("agente com lista de números de teste não assume número de fora", async () => {
    mocks.userFindFirst.mockResolvedValue(agent({ allowedPhoneNumbers: ["5511911112222"] }));

    const r = await resolveV2AgentForConversation("conv-1");

    expect(r).toBeNull();
    expect(mocks.conversationUpdateMany).not.toHaveBeenCalled();
  });

  it("número dentro da lista de teste é atribuído", async () => {
    mocks.userFindFirst.mockResolvedValue(agent({ allowedPhoneNumbers: ["+55 11 98888-7777"] }));

    const r = await resolveV2AgentForConversation("conv-1");

    expect(r?.wasAssigned).toBe(true);
  });

  it("atendimento IA desligado na org: não atribui", async () => {
    mocks.attendanceEnabled.mockResolvedValue(false);

    const r = await resolveV2AgentForConversation("conv-1");

    expect(r).toBeNull();
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it("conversa já do agente v2 segue com ele (não depende do kill-switch)", async () => {
    mocks.attendanceEnabled.mockResolvedValue(false);
    mocks.conversationFindUnique.mockResolvedValue({
      ...UNASSIGNED,
      assignedToId: "ai-user-1",
      assignedTo: { id: "ai-user-1", aiAgentConfig: { id: "agent-1", engine: "simple" } },
    });

    const r = await resolveV2AgentForConversation("conv-1");

    expect(r).toMatchObject({ userId: "ai-user-1", wasAssigned: false });
  });
});

describe("pickAgentForConversation", () => {
  const ag = (id: string, cfg: Record<string, unknown> = {}) => ({ id, aiAgentConfig: { id: `cfg-${id}`, simpleConfig: cfg } });

  it("vence o agente vinculado ao canal da conversa, mesmo não sendo o mais antigo", async () => {
    const { pickAgentForConversation } = await import("../agent-resolver");
    const agents = [ag("antigo", { channelIds: ["ch-a"] }), ag("novo", { channelIds: ["ch-b"] })];
    expect(pickAgentForConversation(agents, "ch-b", "5511999999999")?.id).toBe("novo");
  });

  it("sem agente do canal, fica com o primeiro que atende qualquer canal", async () => {
    const { pickAgentForConversation } = await import("../agent-resolver");
    const agents = [ag("a", { channelIds: ["ch-a"] }), ag("geral")];
    expect(pickAgentForConversation(agents, "ch-x", "5511999999999")?.id).toBe("geral");
    expect(pickAgentForConversation([ag("a", { channelIds: ["ch-a"] })], "ch-x", "5511999999999")).toBeNull();
  });

  it("lista de números de teste de cada agente continua valendo", async () => {
    const { pickAgentForConversation } = await import("../agent-resolver");
    const agents = [ag("teste", { allowedPhoneNumbers: ["5511911112222"] }), ag("geral")];
    expect(pickAgentForConversation(agents, null, "5511999999999")?.id).toBe("geral");
  });
});
