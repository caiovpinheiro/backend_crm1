/**
 * `scheduled_message_updated` sai do SERVIÇO (um ponto só) — criar,
 * cancelar (manual e em lote por resposta/encerramento), enviar e falhar.
 * Assim todos os callers (rota, webhook Meta/Baileys, worker, envio
 * outbound) avisam o banner das outras abas sem repetir o publish.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  publish: vi.fn(),
  create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "sm_1",
    organizationId: "org_1",
    ...args.data,
  })),
  findMany: vi.fn(async () => [] as Array<{ id: string; organizationId: string }>),
  updateMany: vi.fn(async () => ({ count: 0 })),
  findUnique: vi.fn(async () => null as unknown),
  update: vi.fn(async (args: { where: { id: string } }) => ({
    id: args.where.id,
    organizationId: "org_1",
    conversationId: "conv_1",
    createdById: "user_a",
    content: "oi",
    fallbackTemplateName: null,
  })),
}));

vi.mock("@prisma/client", () => ({
  ScheduledMessageStatus: {
    PENDING: "PENDING",
    CANCELLED: "CANCELLED",
    SENT: "SENT",
    FAILED: "FAILED",
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    scheduledMessage: {
      create: db.create,
      findMany: db.findMany,
      updateMany: db.updateMany,
      findUnique: db.findUnique,
      update: db.update,
    },
    // `createScheduledMessage` valida a conversa; o log nos deals usa o
    // mesmo delegate e, sem contato, vira no-op.
    conversation: {
      findUnique: vi.fn(async () => ({ id: "conv_1", channel: "whatsapp", status: "OPEN" })),
    },
    deal: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: (data: Record<string, unknown>) => ({ ...data, organizationId: "org_1" }),
}));
vi.mock("@/services/deals", () => ({ createDealEvent: vi.fn() }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: db.publish } }));

import {
  cancelPendingForConversation,
  cancelScheduledMessage,
  createScheduledMessage,
  markAsFailed,
  markAsSent,
} from "@/services/scheduled-messages";

function published() {
  return db.publish.mock.calls
    .filter(([event]) => event === "scheduled_message_updated")
    .map(([, payload]) => payload);
}

describe("scheduled-messages → scheduled_message_updated", () => {
  beforeEach(() => {
    db.publish.mockReset();
    db.findMany.mockReset();
    db.findMany.mockResolvedValue([]);
    db.updateMany.mockReset();
    db.updateMany.mockResolvedValue({ count: 0 });
    db.findUnique.mockReset();
    db.findUnique.mockResolvedValue(null);
  });

  it("criar → status PENDING com o id do agendamento", async () => {
    await createScheduledMessage({
      conversationId: "conv_1",
      createdById: "user_a",
      content: "lembrete",
      scheduledAt: new Date(Date.now() + 60_000),
    });
    expect(published()).toEqual([
      {
        organizationId: "org_1",
        conversationId: "conv_1",
        scheduledMessageId: "sm_1",
        status: "PENDING",
      },
    ]);
  });

  it("cancelamento em lote (resposta do cliente) → um evento por conversa", async () => {
    db.findMany.mockResolvedValue([
      { id: "sm_1", organizationId: "org_1" },
      { id: "sm_2", organizationId: "org_1" },
    ]);
    db.updateMany.mockResolvedValue({ count: 2 });
    const n = await cancelPendingForConversation("conv_1", "client_reply");
    expect(n).toBe(2);
    expect(published()).toEqual([
      {
        organizationId: "org_1",
        conversationId: "conv_1",
        scheduledMessageId: null,
        status: "CANCELLED",
      },
    ]);
  });

  it("sem pendentes não publica nada", async () => {
    await cancelPendingForConversation("conv_1", "agent_reply");
    expect(published()).toEqual([]);
  });

  it("cancelamento manual → CANCELLED com o id", async () => {
    db.findUnique.mockResolvedValue({
      id: "sm_1",
      status: "PENDING",
      conversationId: "conv_1",
    });
    await cancelScheduledMessage("sm_1", "user_a");
    expect(published()).toEqual([
      {
        organizationId: "org_1",
        conversationId: "conv_1",
        scheduledMessageId: "sm_1",
        status: "CANCELLED",
      },
    ]);
  });

  it("cancelar o que já não está pendente não publica", async () => {
    db.findUnique.mockResolvedValue({
      id: "sm_1",
      status: "SENT",
      conversationId: "conv_1",
    });
    await cancelScheduledMessage("sm_1", "user_a");
    expect(published()).toEqual([]);
  });

  it("enviado e falhou → SENT / FAILED", async () => {
    await markAsSent("sm_1", { sentMessageId: "msg_1" });
    await markAsFailed("sm_2", "sessão expirada");
    expect(published()).toEqual([
      {
        organizationId: "org_1",
        conversationId: "conv_1",
        scheduledMessageId: "sm_1",
        status: "SENT",
      },
      {
        organizationId: "org_1",
        conversationId: "conv_1",
        scheduledMessageId: "sm_2",
        status: "FAILED",
      },
    ]);
  });
});
