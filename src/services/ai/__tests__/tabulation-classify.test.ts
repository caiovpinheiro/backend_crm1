import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fireTrigger,
  runAgent,
  listActiveTabulationLeaves,
  resolveTabulationForStep,
  resolveClassifierFallbackTabulation,
  updateConversationStatusInDb,
} = vi.hoisted(() => ({
  fireTrigger: vi.fn(async () => null),
  runAgent: vi.fn(),
  listActiveTabulationLeaves: vi.fn(),
  resolveTabulationForStep: vi.fn(),
  resolveClassifierFallbackTabulation: vi.fn(),
  updateConversationStatusInDb: vi.fn(async () => null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    message: { findMany: vi.fn() },
    deal: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: vi.fn(async () => false),
}));

vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn(async () => null),
}));

vi.mock("@/services/automation-triggers", () => ({
  fireTrigger,
}));

vi.mock("@/services/conversations", () => ({
  updateConversationStatusInDb,
}));

vi.mock("@/services/tabulations", () => ({
  formatTabulationCatalogBlock: vi.fn(() => ""),
  listActiveTabulationLeaves,
  resolveClassifierFallbackTabulation,
  resolveTabulationForStep,
  tabulationLogMeta: () => ({}),
}));

vi.mock("@/services/ai/runner", () => ({
  runAgent,
}));

import { prisma } from "@/lib/prisma";
import {
  applyConversationTabulation,
} from "@/services/ai/tabulation-classify";

const LEAF = {
  id: "only-leaf",
  number: 1,
  path: "Geral > Encerramento",
  departmentId: "dept-1",
  departmentName: "Atendimento",
};

const CHOSEN = {
  tabulationId: "only-leaf",
  ancestorIds: [] as string[],
  departmentId: "dept-1",
  name: "Encerramento",
  number: 1,
};

function classifierUser() {
  return {
    id: "agent-1",
    type: "AI",
    name: "Tabulador",
    aiAgentConfig: {
      id: "cfg-1",
      active: true,
      archetype: "TABULACAO",
      enabledTools: ["list_tabulations", "tabulate_conversation"],
    },
  };
}

function openConversation() {
  return {
    id: "conv-1",
    organizationId: "org-1",
    departmentId: "dept-1",
    contactId: "contact-1",
    status: "OPEN",
    tabulationId: null,
    externalId: "ext-1",
  };
}

describe("applyConversationTabulation — trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTabulationForStep.mockResolvedValue(CHOSEN);
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(
      openConversation() as never,
    );
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as never);
    vi.mocked(prisma.deal.findFirst).mockResolvedValue(null);
  });

  it("não dispara conversation_tabulated quando classifica sem fechar", async () => {
    const result = await applyConversationTabulation({
      conversationId: "conv-1",
      organizationId: "org-1",
      tabulationId: "only-leaf",
      closeIfOpen: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.closed).toBe(false);
    expect(fireTrigger).not.toHaveBeenCalled();
  });

  it("dispara conversation_tabulated só quando closed === true", async () => {
    const result = await applyConversationTabulation({
      conversationId: "conv-1",
      organizationId: "org-1",
      tabulationId: "only-leaf",
      closeIfOpen: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.closed).toBe(true);
    expect(updateConversationStatusInDb).toHaveBeenCalled();
    expect(fireTrigger).toHaveBeenCalledWith(
      "conversation_tabulated",
      expect.objectContaining({
        data: expect.objectContaining({ conversationId: "conv-1" }),
      }),
    );
  });

  it("recusa sobrescrever folha já gravada", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      ...openConversation(),
      tabulationId: "human-leaf",
    } as never);
    const result = await applyConversationTabulation({
      conversationId: "conv-1",
      organizationId: "org-1",
      tabulationId: "only-leaf",
      source: "AI_AGENT",
    });
    expect(result).toEqual({
      ok: false,
      error: "Conversa já tabulada. Não sobrescreva a folha.",
    });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(fireTrigger).not.toHaveBeenCalled();
  });
});
