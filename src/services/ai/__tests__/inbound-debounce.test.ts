import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheStore = new Map<string, unknown>();

vi.mock("@/lib/cache", () => ({
  cache: {
    tryClaim: vi.fn(async (key: string) => {
      if (cacheStore.has(`claim:${key}`)) return false;
      cacheStore.set(`claim:${key}`, "1");
      return true;
    }),
    get: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
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
    conversation: {
      findUnique: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { cache } from "@/lib/cache";
import { prisma } from "@/lib/prisma";
import {
  cancelAiReplyDebounce,
  claimInboundMessageForAi,
  DEFAULT_AI_DEBOUNCE_MS,
} from "@/services/ai/inbound-debounce";
import { assertAiStillAuthorized } from "@/services/ai/inbox-handler";
import { matchHandoffKeyword } from "@/lib/ai-agents/piloting";
import { ACADEMIC_HANDOFF_KEYWORDS } from "@/lib/ai-agents/academic-atendimento-prompt";

describe("inbound-debounce claim + cancel", () => {
  beforeEach(() => {
    cacheStore.clear();
    vi.clearAllMocks();
  });

  it("claimInboundMessageForAi permite a primeira e bloqueia duplicata", async () => {
    expect(await claimInboundMessageForAi("msg-1")).toBe(true);
    expect(await claimInboundMessageForAi("msg-1")).toBe(false);
    expect(await claimInboundMessageForAi(null)).toBe(true);
  });

  it("cancelAiReplyDebounce limpa generation cache", async () => {
    await cache.set("ai:gen:conv-1", "gen-abc", 60);
    cancelAiReplyDebounce("conv-1", "human_outbound");
    expect(cache.del).toHaveBeenCalledWith("ai:gen:conv-1");
  });

  it("DEFAULT_AI_DEBOUNCE_MS está na faixa pedida (2–3s)", () => {
    expect(DEFAULT_AI_DEBOUNCE_MS).toBeGreaterThanOrEqual(2000);
    expect(DEFAULT_AI_DEBOUNCE_MS).toBeLessThanOrEqual(3000);
  });
});

describe("assertAiStillAuthorized", () => {
  beforeEach(() => {
    cacheStore.clear();
    vi.clearAllMocks();
  });

  it("bloqueia generation supersedida", async () => {
    cacheStore.set("ai:gen:c1", "gen-new");
    const r = await assertAiStillAuthorized({
      conversationId: "c1",
      expectedAgentUserId: "ai-user",
      generationId: "gen-old",
    });
    expect(r).toEqual({ ok: false, reason: "generation_superseded" });
  });

  it("bloqueia se assignee não é AI", async () => {
    cacheStore.set("ai:gen:c1", "gen-1");
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedToId: "human-1",
      hasHumanReply: false,
      assignedTo: { type: "HUMAN" },
    } as never);
    const r = await assertAiStillAuthorized({
      conversationId: "c1",
      expectedAgentUserId: "human-1",
      generationId: "gen-1",
    });
    expect(r).toEqual({ ok: false, reason: "assignee_not_ai" });
  });

  it("autoriza agente AI mesmo com outbound humana histórica", async () => {
    cacheStore.set("ai:gen:c1", "gen-1");
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedToId: "ai-user",
      hasHumanReply: true,
      assignedTo: { type: "AI" },
    } as never);
    const r = await assertAiStillAuthorized({
      conversationId: "c1",
      expectedAgentUserId: "ai-user",
      generationId: "gen-1",
    });
    expect(r).toEqual({ ok: true });
  });

  it("autoriza agente AI sem outbound humana", async () => {
    cacheStore.set("ai:gen:c1", "gen-1");
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      assignedToId: "ai-user",
      hasHumanReply: false,
      assignedTo: { type: "AI" },
    } as never);
    const r = await assertAiStillAuthorized({
      conversationId: "c1",
      expectedAgentUserId: "ai-user",
      generationId: "gen-1",
    });
    expect(r).toEqual({ ok: true });
  });
});

describe("academic handoff keywords", () => {
  it("detecta frases do agente antigo", () => {
    expect(
      matchHandoffKeyword("quero falar com atendente por favor", ACADEMIC_HANDOFF_KEYWORDS),
    ).toBeTruthy();
    expect(
      matchHandoffKeyword("preciso de uma pessoa real", ACADEMIC_HANDOFF_KEYWORDS),
    ).toBeTruthy();
    expect(
      matchHandoffKeyword("como acesso o portal?", ACADEMIC_HANDOFF_KEYWORDS),
    ).toBeNull();
  });
});

describe("parseAgentConfidence", () => {
  it("extrai score e remove marcador", async () => {
    const { parseAgentConfidence, shouldHandoffOnLowConfidence } = await import(
      "@/services/ai/confidence"
    );
    const r = parseAgentConfidence("Opa! Segue o passo.\n\n[CONFIANCA:0.85]");
    expect(r.text).toBe("Opa! Segue o passo.");
    expect(r.confidence).toBe(0.85);
    expect(shouldHandoffOnLowConfidence(0.39)).toBe(true);
    expect(shouldHandoffOnLowConfidence(0.4)).toBe(false);
    expect(shouldHandoffOnLowConfidence(null)).toBe(false);
  });
});
