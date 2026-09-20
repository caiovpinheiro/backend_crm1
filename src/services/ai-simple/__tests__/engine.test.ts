/**
 * Testes do motor v2 simples — tudo mockado, sem banco/LLM/org reais.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { processSimpleTurn, type SimpleTurnInput, type SimpleEngineDeps } from "@/services/ai-simple/engine";
import { normalizeSimpleConfig } from "@/lib/ai-simple/config";
import type { SimpleAction, SimpleConfig, SimpleLLMOutput } from "@/lib/ai-simple/types";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: vi.fn() },
    contact: { findUnique: vi.fn(), findFirst: vi.fn() },
    deal: { findFirst: vi.fn() },
    message: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

const rawBaseConfig = {
  tone: "simpática",
  rules: "Regra teste",
  context_fields: { contact: ["name", "phone"], deal: ["title"] },
  confirmation_message: "Oi {{contact.name}}, confirmo {{deal.title}}?",
  on_deal_not_found: "ask_identification",
  identification_message: "Me passa seu e-mail?",
  knowledge: "",
  modes: [{ id: "test_mode", when: "teste", instructions: "Instruções de teste" }],
  allowed_actions: ["add_tag"],
  allowed_fields: [],
  handoff_message: "Vou te passar para humano.",
  handoff_queue: "",
  history_limit: 10,
};

const baseConfig = normalizeSimpleConfig(rawBaseConfig);

function mockConversation(engine: "legacy" | "simple" = "simple", simpleConfig = rawBaseConfig) {
  (prisma.conversation.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    assignedTo: {
      id: "agent-user-id",
      type: "AI",
      aiAgentConfig: {
        id: "agent-config-id",
        engine,
        simpleConfig,
        model: "gpt-4o-mini",
        temperature: 0.5,
        user: { id: "agent-user-id", name: "Agente Teste" },
      },
    },
  });
}

function mockContactDeal(deal: { id: string; title: string } | null | Array<{ id: string; title: string } | null>) {
  (prisma.contact.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "contact-id",
    name: "João",
    phone: "+5511999999999",
    email: "joao@example.com",
    tags: [],
  });
  const fn = prisma.deal.findFirst as ReturnType<typeof vi.fn>;
  fn.mockReset();
  if (Array.isArray(deal)) {
    for (const d of deal) {
      fn.mockResolvedValueOnce(d ? { ...d, status: "OPEN", stage: { name: "Novo" } } : null);
    }
  } else {
    fn.mockResolvedValue(deal ? { ...deal, status: "OPEN", stage: { name: "Novo" } } : null);
  }
}

function mockHistory(messages: Array<{ direction: "in" | "out"; content: string }> = []) {
  (prisma.message.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    messages.map((m) => ({ ...m, isPrivate: false, messageType: "text", authorType: m.direction === "out" ? "bot" : "human" })),
  );
}

function makeGenerate(output: SimpleLLMOutput | null) {
  return vi.fn().mockResolvedValue({
    ok: true,
    output,
    inputTokens: 10,
    outputTokens: 5,
    raw: JSON.stringify(output),
  });
}

function baseInput(userMessage = "Oi", stage = "new", attempts = 0, humanActive = false): SimpleTurnInput {
  return {
    organizationId: "org-id",
    conversationId: "conv-id",
    contactId: "contact-id",
    channel: "meta",
    userMessage,
    turnId: "turn-id",
  };
}

function baseDeps(overrides: Partial<SimpleEngineDeps> = {}): SimpleEngineDeps {
  return {
    generate: makeGenerate(null),
    send: vi.fn().mockResolvedValue({ status: "sent", messageId: "msg-id" }),
    handoff: vi.fn().mockResolvedValue({ ok: true, queuedWaiting: false }),
    executeActions: vi.fn().mockResolvedValue({ executed: [], discarded: [] }),
    ensureState: vi.fn().mockResolvedValue({
      id: "state-id",
      stage: "new",
      mode: null,
      humanActive: false,
      identificationAttempts: 0,
    }),
    updateState: vi.fn().mockResolvedValue(undefined),
    createLog: vi.fn().mockResolvedValue({ id: "log-id" }),
    ...overrides,
  };
}

function state(
  stage: string,
  opts: { mode?: string | null; humanActive?: boolean; identificationAttempts?: number } = {},
) {
  return {
    id: "state-id",
    stage,
    mode: opts.mode ?? null,
    humanActive: opts.humanActive ?? false,
    identificationAttempts: opts.identificationAttempts ?? 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHistory();
});

describe("processSimpleTurn", () => {
  it("stage new + deal existente envia confirmation_message e vai para awaiting_confirmation", async () => {
    mockConversation("simple");
    mockContactDeal({ id: "deal-id", title: "Negócio A" });

    const deps = baseDeps();
    const result = await processSimpleTurn(baseInput(), deps);

    expect(result.nextStage).toBe("awaiting_confirmation");
    expect(result.handoff).toBe(false);
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Oi João, confirmo Negócio A?" }));
  });

  it("stage new + sem deal + on_deal_not_found=ask_identification envia identification_message", async () => {
    mockConversation("simple");
    mockContactDeal(null);

    const deps = baseDeps();
    await processSimpleTurn(baseInput(), deps);

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Me passa seu e-mail?" }));
  });

  it("stage new + sem deal + on_deal_not_found=handoff dispara handoff", async () => {
    const handoffConfig = { ...rawBaseConfig, on_deal_not_found: "handoff" };
    mockConversation("simple", handoffConfig);
    mockContactDeal(null);

    const deps = baseDeps();
    const result = await processSimpleTurn(baseInput(), deps);

    expect(result.handoff).toBe(true);
    expect(deps.handoff).toHaveBeenCalled();
    expect(deps.send).toHaveBeenCalled();
  });

  it("awaiting_identification + e-mail identifica deal e envia confirmation", async () => {
    mockConversation("simple");
    mockContactDeal([
      null,
      { id: "found-deal-id", title: "Negócio B" },
    ]);
    (prisma.contact.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "other-contact-id" });

    const deps = baseDeps({ ensureState: vi.fn().mockResolvedValue(state("awaiting_identification")) });
    const result = await processSimpleTurn(baseInput("joao@example.com"), deps);

    expect(result.nextStage).toBe("awaiting_confirmation");
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Oi João, confirmo Negócio B?" }));
  });

  it("awaiting_identification sem sucesso após 2 tentativas dispara handoff", async () => {
    mockConversation("simple");
    mockContactDeal(null);

    const deps = baseDeps({ ensureState: vi.fn().mockResolvedValue(state("awaiting_identification", { identificationAttempts: 1 })) });
    const result = await processSimpleTurn(baseInput("não sei"), deps);

    expect(result.handoff).toBe(true);
    expect(deps.handoff).toHaveBeenCalled();
  });

  it("resposta normal executa ações permitidas e descarta as proibidas", async () => {
    mockConversation("simple");
    mockContactDeal({ id: "deal-id", title: "Negócio A" });

    const output: SimpleLLMOutput = {
      reply: "Marquei a tag.",
      confirmed: null,
      mode: null,
      actions: [
        { tool: "add_tag", args: { tagName: "interessado" } },
        { tool: "create_deal", args: { title: "Novo negócio" } },
      ],
      handoff: false,
      reason: "tag",
    };

    const executeActions = vi.fn().mockResolvedValue({
      executed: [{ type: "add_tag", args: { tagName: "interessado" } }],
      discarded: [{ type: "create_deal", args: { title: "Novo negócio" } }],
    });
    const deps = baseDeps({
      generate: makeGenerate(output),
      executeActions,
      ensureState: vi.fn().mockResolvedValue(state("active")),
    });

    const result = await processSimpleTurn(baseInput(), deps);

    expect(result.reply).toBe("Marquei a tag.");
    expect(result.actionsExecuted).toHaveLength(1);
    expect(result.actionsDiscarded).toHaveLength(1);
    expect(executeActions).toHaveBeenCalledWith(expect.objectContaining({ allowedActions: ["add_tag"] }));
  });

  it("handoff=true dispara handoff único", async () => {
    mockConversation("simple");
    mockContactDeal({ id: "deal-id", title: "Negócio A" });

    const output: SimpleLLMOutput = {
      reply: "Não sei resolver.",
      confirmed: null,
      mode: null,
      actions: [],
      handoff: true,
      reason: "tema complexo",
    };

    const deps = baseDeps({
      generate: makeGenerate(output),
      ensureState: vi.fn().mockResolvedValue(state("active")),
    });
    const result = await processSimpleTurn(baseInput(), deps);

    expect(result.handoff).toBe(true);
    expect(deps.handoff).toHaveBeenCalled();
  });

  it("JSON inválido do LLM tenta uma vez e, se falhar de novo, dispara handoff", async () => {
    mockConversation("simple");
    mockContactDeal({ id: "deal-id", title: "Negócio A" });

    const generate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "JSON inválido", inputTokens: 10, outputTokens: 0, raw: "não é json" })
      .mockResolvedValueOnce({ ok: false, error: "JSON inválido", inputTokens: 10, outputTokens: 0, raw: "ainda não é json" });

    const deps = baseDeps({
      generate,
      ensureState: vi.fn().mockResolvedValue(state("active")),
    });
    const result = await processSimpleTurn(baseInput(), deps);

    expect(result.handoff).toBe(true);
    expect(deps.handoff).toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("humanActive=true não responde", async () => {
    mockConversation("simple");
    mockContactDeal({ id: "deal-id", title: "Negócio A" });

    const deps = baseDeps({ ensureState: vi.fn().mockResolvedValue(state("active", { humanActive: true })) });
    const result = await processSimpleTurn(baseInput(), deps);

    expect(result.reply).toBeNull();
    expect(result.handoff).toBe(false);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("conversa atribuída a agente legacy dispara erro (não invade v1)", async () => {
    mockConversation("legacy");
    mockContactDeal({ id: "deal-id", title: "Negócio A" });

    await expect(processSimpleTurn(baseInput(), baseDeps())).rejects.toThrow("engine");
  });
});
