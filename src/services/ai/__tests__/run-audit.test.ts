import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findUnique: vi.fn() },
    aIAgentRun: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    conversation: { findUnique: vi.fn() },
    distributionPending: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: <T,>(data: T) => ({ ...data, organizationId: "org-1" }),
}));

vi.mock("@/lib/ai-agents/observability", () => ({
  behaviorSliceFromAgent: () => ({}),
  hashAgentBehaviorConfig: () => "hash-1",
}));

import { prisma } from "@/lib/prisma";
import { markRunResponseDiscarded } from "@/services/ai/run-delivery";
import { recordInboxInterceptRun } from "@/services/ai/record-intercept-run";

function createdRun(): Record<string, unknown> {
  const call = vi.mocked(prisma.aIAgentRun.create).mock.calls[0]?.[0] as
    | { data: Record<string, unknown> }
    | undefined;
  return call?.data ?? {};
}

describe("recordInboxInterceptRun — outcome do intercepto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aIAgentRun.create).mockResolvedValue({} as never);
    vi.mocked(prisma.distributionPending.findFirst).mockResolvedValue(
      null as never,
    );
  });

  it("sintoma original: transferência real ficava invisível (outcome null)", async () => {
    // Áudio do cliente → intercepto distribuiu e um humano assumiu.
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedTo: { type: "HUMAN" },
    } as never);

    await recordInboxInterceptRun({
      agentId: "agent-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      interceptName: "inbound_audio",
      configHash: "hash-1",
    });

    const data = createdRun();
    expect(data.outcome).toBe("HANDOFF_COMPLETED");
    expect(data.status).toBe("HANDOFF");
    expect(data.handoffReason).toBe("intercept:inbound_audio");
  });

  it("enfileirado sem responsável elegível vira HANDOFF_QUEUED", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedTo: { type: "AI" },
    } as never);
    vi.mocked(prisma.distributionPending.findFirst).mockResolvedValue({
      id: "pending-1",
    } as never);

    await recordInboxInterceptRun({
      agentId: "agent-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      interceptName: "retention_intent",
      configHash: "hash-1",
    });

    const data = createdRun();
    expect(data.outcome).toBe("HANDOFF_QUEUED");
    expect(data.status).toBe("HANDOFF");
  });

  it("intercepto que respondeu e manteve a IA é ANSWERED", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedTo: { type: "AI" },
    } as never);

    await recordInboxInterceptRun({
      agentId: "agent-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      interceptName: "first_access",
      configHash: "hash-1",
    });

    const data = createdRun();
    expect(data.outcome).toBe("ANSWERED");
    expect(data.status).toBe("COMPLETED");
    expect(data.handoffReason).toBeNull();
  });

  it("anexo ignorado por configuração registra o motivo, não some", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedTo: { type: "AI" },
    } as never);

    await recordInboxInterceptRun({
      agentId: "agent-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      interceptName: "inbound_media_ignore",
      configHash: "hash-1",
      outcome: "RESPONSE_DISCARDED",
      discardReason: "media_ignored: sticker",
    });

    const data = createdRun();
    expect(data.outcome).toBe("RESPONSE_DISCARDED");
    expect(String(data.errorMessage)).toContain("media_ignored: sticker");
  });
});

describe("markRunResponseDiscarded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aIAgentRun.update).mockResolvedValue({} as never);
  });

  it("sintoma original: run ANSWERED sem nenhuma outbound", async () => {
    vi.mocked(prisma.aIAgentRun.findUnique).mockResolvedValue({
      outcome: "ANSWERED",
      status: "COMPLETED",
    } as never);

    await markRunResponseDiscarded({
      runId: "run-1",
      reason: "near_duplicate",
    });

    const arg = vi.mocked(prisma.aIAgentRun.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.outcome).toBe("RESPONSE_DISCARDED");
    expect(String(arg.data.errorMessage)).toContain("[descartada]");
    expect(String(arg.data.errorMessage)).toContain("near_duplicate");
  });

  it("persiste o detalhe da falha de envio", async () => {
    vi.mocked(prisma.aIAgentRun.findUnique).mockResolvedValue({
      outcome: "NO_CONTEXT",
      status: "COMPLETED",
    } as never);

    await markRunResponseDiscarded({
      runId: "run-1",
      reason: "send_failed",
      detail: "Meta code 131047",
    });

    const arg = vi.mocked(prisma.aIAgentRun.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(String(arg.data.errorMessage)).toContain("Meta code 131047");
  });

  it("não apaga a causa raiz de um handoff já registrado", async () => {
    vi.mocked(prisma.aIAgentRun.findUnique).mockResolvedValue({
      outcome: "HANDOFF_COMPLETED",
      status: "HANDOFF",
    } as never);

    await markRunResponseDiscarded({
      runId: "run-1",
      reason: "near_duplicate",
    });

    expect(prisma.aIAgentRun.update).not.toHaveBeenCalled();
  });

  it("não sobrescreve run que falhou de verdade", async () => {
    vi.mocked(prisma.aIAgentRun.findUnique).mockResolvedValue({
      outcome: null,
      status: "FAILED",
    } as never);

    await markRunResponseDiscarded({ runId: "run-1", reason: "empty_reply" });

    expect(prisma.aIAgentRun.update).not.toHaveBeenCalled();
  });
});
