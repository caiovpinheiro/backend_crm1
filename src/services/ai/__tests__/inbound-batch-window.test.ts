import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache", () => ({
  cache: {
    tryClaim: vi.fn(async () => true),
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org-1",
  getRequestContext: () => ({ userId: "system", organizationId: "org-1" }),
  runWithContext: async (_ctx: unknown, fn: () => Promise<void>) => fn(),
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSetting: vi.fn(async () => null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

import { DEFAULT_INBOUND_BATCH_WINDOW_MINUTES } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";
import { collectUnansweredInboundText } from "@/services/ai/inbound-debounce";

/** 07/09: "oi" às 16:43 arrastou o lote de 16:13. */
const AT_1613 = new Date("2026-09-07T19:13:00.000Z");
const AT_1615 = new Date("2026-09-07T19:15:00.000Z");
const AT_1643 = new Date("2026-09-07T19:43:00.000Z");

function mockAgent(inboxPolicy: unknown) {
  vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
    assignedTo: {
      type: "AI",
      aiAgentConfig: { inboxPolicy, verticalPack: null },
    },
  } as never);
}

function mockInbound(rows: Array<{ content: string; createdAt: Date }>) {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.message.findMany).mockResolvedValue(
    rows.map((r) => ({
      content: r.content,
      authorType: "contact",
      messageType: "text",
      createdAt: r.createdAt,
    })) as never,
  );
}

describe("collectUnansweredInboundText — teto temporal do lote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sintoma original: 'oi' às 16:43 não arrasta mensagens de 16:13", async () => {
    mockAgent(null);
    mockInbound([
      { content: "quero cancelar meu curso", createdAt: AT_1613 },
      { content: "alguém pode me ajudar", createdAt: AT_1615 },
      { content: "oi", createdAt: AT_1643 },
    ]);
    const text = await collectUnansweredInboundText("conv-1");
    expect(text).toBe("oi");
    expect(text).not.toContain("cancelar");
  });

  it("mensagens dentro da janela continuam agrupadas", async () => {
    mockAgent(null);
    mockInbound([
      { content: "bom dia", createdAt: new Date(AT_1643.getTime() - 60_000) },
      { content: "preciso da segunda via", createdAt: AT_1643 },
    ]);
    expect(await collectUnansweredInboundText("conv-1")).toBe(
      "bom dia\npreciso da segunda via",
    );
  });

  it("janela é configurável por agente", async () => {
    mockAgent({ inboundBatchWindowMinutes: 60 });
    mockInbound([
      { content: "quero cancelar meu curso", createdAt: AT_1613 },
      { content: "oi", createdAt: AT_1643 },
    ]);
    expect(await collectUnansweredInboundText("conv-1")).toBe(
      "quero cancelar meu curso\noi",
    );
  });

  it("0 desliga o teto (comportamento antigo, opt-in explícito)", async () => {
    mockAgent({ inboundBatchWindowMinutes: 0 });
    mockInbound([
      { content: "quero cancelar meu curso", createdAt: AT_1613 },
      { content: "oi", createdAt: AT_1643 },
    ]);
    expect(await collectUnansweredInboundText("conv-1")).toBe(
      "quero cancelar meu curso\noi",
    );
  });

  it("sem agente IA atribuído usa o default seguro", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue(null as never);
    mockInbound([
      { content: "quero cancelar meu curso", createdAt: AT_1613 },
      { content: "oi", createdAt: AT_1643 },
    ]);
    expect(await collectUnansweredInboundText("conv-1")).toBe("oi");
    expect(DEFAULT_INBOUND_BATCH_WINDOW_MINUTES).toBeGreaterThan(0);
    expect(DEFAULT_INBOUND_BATCH_WINDOW_MINUTES).toBeLessThan(30);
  });

  it("janela é ancorada na mensagem mais nova, não em `now`", async () => {
    // Turno processado com atraso: as duas mensagens são de 2 horas atrás,
    // mas a 1 minuto uma da outra — continuam no mesmo turno.
    mockAgent(null);
    const base = Date.now() - 2 * 60 * 60 * 1000;
    mockInbound([
      { content: "preciso trancar", createdAt: new Date(base) },
      { content: "consegue?", createdAt: new Date(base + 60_000) },
    ]);
    expect(await collectUnansweredInboundText("conv-1")).toBe(
      "preciso trancar\nconsegue?",
    );
  });
});
