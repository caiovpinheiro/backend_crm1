/**
 * BD-5: a listagem de conversas só-IA ociosas parte de `ai_agent_configs`
 * e entra em `conversations` por (organizationId, assignedToId, status,
 * hasHumanReply); `contact.name` vem no SELECT — o loop não faz
 * `contact.findUnique` por linha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as string[],
  rowsByCall: [] as unknown[][],
  contactFindUnique: vi.fn(async () => ({ name: "NÃO DEVERIA" })),
  sendAgentMessage: vi.fn(async () => ({ status: "sent" })),
  closeAiOnlyConversation: vi.fn(async () => ({ closed: true })),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      h.queries.push(strings.join("?"));
      return h.rowsByCall.shift() ?? [];
    }),
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findUnique: h.contactFindUnique },
    deal: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: vi.fn(async (_org: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/ai-agents/piloting", () => ({
  normalizeAutoClosePolicy: (raw: unknown) =>
    (raw as { idleMessage?: string | null }) ?? { idleMessage: null },
  normalizeBusinessHours: () => null,
  renderTemplate: (tpl: string, vars: Record<string, string | null>) =>
    tpl.replace("{{contactName}}", vars.contactName ?? ""),
  isWithinBusinessHours: () => true,
}));
vi.mock("@/services/ai/agent-vertical", () => ({
  resolveAgentVerticalByAgentUserId: vi.fn(async () => ({ ops: {} })),
}));
vi.mock("@/services/ai/close-ai-conversation", () => ({
  closeAiOnlyConversation: h.closeAiOnlyConversation,
}));
vi.mock("@/services/ai/idle-followup", () => ({
  IDLE_CLOSE_AFTER_NUDGE_MS: 30 * 60 * 1000,
  IDLE_NUDGE_MS: 30 * 60 * 1000,
  buildIdleNudgeMessage: () => "Ainda posso ajudar?",
  isIdleNudgeContent: (c: string | null) => c === "Ainda posso ajudar?",
}));
vi.mock("@/services/ai/piloting-actions", () => ({
  executeAgentHandoff: vi.fn(async () => undefined),
  sendAgentMessage: h.sendAgentMessage,
}));
vi.mock("@/lib/distribution-execute-queue", () => ({
  enqueueDistributionStuckInbound: vi.fn(async () => true),
}));
vi.mock("@/services/ai/retry-unanswered-ai-inbound", () => ({
  AI_RETRY_UNANSWERED_MS: 0,
  retryUnansweredAiInbound: vi.fn(async () => ({ retried: 0 })),
}));
vi.mock("@/services/ai/stuck-inbound-distribution", () => ({
  STUCK_INBOUND_MS: 60_000,
}));
vi.mock("@/services/ai-v2/inactivity", () => ({
  processIdleV2: vi.fn(async () => undefined),
}));

import { tickOnce } from "@/services/ai-agent-inactivity-worker";

const NOW = new Date("2026-09-30T12:00:00.000Z");

beforeEach(() => {
  h.queries.length = 0;
  h.rowsByCall.length = 0;
  h.contactFindUnique.mockClear();
  h.sendAgentMessage.mockClear();
  h.closeAiOnlyConversation.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ai-agent-inactivity-worker (BD-5)", () => {
  it("as duas consultas partem de ai_agent_configs e entram em conversations por org+assignee", async () => {
    await tickOnce(NOW);
    expect(h.queries).toHaveLength(2);
    for (const q of h.queries) {
      expect(q).toMatch(/FROM "ai_agent_configs" a/);
      expect(q).toMatch(/JOIN "conversations" c\s+ON c."organizationId" = a."organizationId"\s+AND c."assignedToId" = a."userId"\s+AND c.status = 'OPEN'/);
      expect(q).toMatch(/LEFT JOIN "contacts" ct ON ct.id = c."contactId"/);
      expect(q).toMatch(/ct.name AS contact_name/);
      // não filtra conversations sem org
      expect(q).not.toMatch(/FROM "conversations" c/);
    }
    expect(h.queries[0]).toMatch(/c."hasHumanReply" = false/);
    expect(h.queries[1]).toMatch(/c."hasHumanReply" = true/);
  });

  it("aviso de encerramento usa contact_name da linha, sem contact.findUnique", async () => {
    const lastOutAt = new Date(NOW.getTime() - 45 * 60 * 1000);
    h.rowsByCall.push([
      {
        conversation_id: "conv_1",
        contact_id: "ct_1",
        contact_name: "Maria",
        organization_id: "org_1",
        assigned_to_id: "ai_1",
        autonomy_mode: "AUTONOMOUS",
        last_out_content: "Ainda posso ajudar?",
        last_out_at: lastOutAt,
        last_in_content: "oi",
        last_inbound_at: new Date(NOW.getTime() - 60 * 60 * 1000),
        auto_close_policy: { idleMessage: "Tchau {{contactName}}" },
      },
    ]);
    const r = await tickOnce(NOW);
    expect(r.closed).toBe(1);
    expect(h.contactFindUnique).not.toHaveBeenCalled();
    expect(h.sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Tchau Maria", kind: "farewell" }),
    );
  });
});
