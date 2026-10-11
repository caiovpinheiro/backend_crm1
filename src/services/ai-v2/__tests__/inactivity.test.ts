import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Passada de inatividade da v2 (`processIdleV2`): aviso, encerramento e o
 * registro de cada um. A decisão em si (`decideV2Idle`) tem os seus casos em
 * engine-params.test.ts; aqui é o que acontece depois dela.
 */

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(async (_sql: string, ..._params: unknown[]): Promise<unknown[]> => []),
  send: vi.fn(async (_args: { conversationId: string; text: string }): Promise<{ sent: boolean; reason?: string }> => ({ sent: true })),
  closeState: vi.fn(async (..._args: unknown[]) => undefined),
  logTurn: vi.fn(async (_args: Record<string, unknown>) => undefined),
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: { $queryRawUnsafe: mocks.queryRaw } }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/lib/webhook-context", () => ({ withSystemContext: async (_org: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("../actions", () => ({
  sendV2TextMessage: mocks.send,
  v2HumanBehavior: () => ({ simulateTyping: false }),
}));
vi.mock("../engine", () => ({ closeState: mocks.closeState }));
vi.mock("../log", () => ({ logV2Turn: mocks.logTurn }));

import { NUDGE_MESSAGE_DEFAULT, processIdleV2 } from "../inactivity";

const NOW = new Date("2026-03-10T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const row = (over: Record<string, unknown> = {}) => ({
  conversation_id: "conv-1",
  organization_id: "org-1",
  contact_id: "ct-1",
  contact_name: "Ana",
  assigned_to_id: "ai-user-1",
  agent_config_id: "agent-1",
  simple_config: {
    name: "Agente",
    tone: "Objetivo",
    autonomyMode: "auto",
    inactivity: { enabled: true, nudgeAfter: 30, closeAfter: 1440 },
  },
  channel_kind: "meta",
  theme_id: null,
  deal_id: "deal-1",
  last_out_content: "Posso ajudar em mais alguma coisa?",
  last_out_at: minutesAgo(45),
  last_inbound_at: minutesAgo(50),
  ...over,
});

describe("passada de inatividade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.send.mockResolvedValue({ sent: true });
  });

  it("sem conversas paradas: não carrega nada e não registra", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    expect(await processIdleV2(NOW)).toEqual({ nudged: 0, closed: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.logTurn).not.toHaveBeenCalled();
  });

  it("prazo do aviso vencido: manda o aviso com a voz do agente e registra o turno sem encerrar", async () => {
    mocks.queryRaw.mockResolvedValue([row()]);
    expect(await processIdleV2(NOW)).toEqual({ nudged: 1, closed: 0 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      contactId: "ct-1",
      agentUserId: "ai-user-1",
      text: NUDGE_MESSAGE_DEFAULT,
      channel: "meta",
      autonomyMode: "AUTONOMOUS",
    }));
    expect(mocks.closeState).not.toHaveBeenCalled();
    expect(mocks.logTurn).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-1",
      conversationId: "conv-1",
      agentId: "agent-1",
      prompt: "inactivity",
      reply: NUDGE_MESSAGE_DEFAULT,
      handoff: false,
      owner: "agente",
      stage: "active",
    }));
    expect(mocks.logTurn.mock.calls[0][0]).not.toHaveProperty("closed");
  });

  it("aviso configurado com variável: sai renderizado; agente em modo sugestão vira rascunho", async () => {
    mocks.queryRaw.mockResolvedValue([row({
      simple_config: {
        name: "Agente",
        tone: "Objetivo",
        autonomyMode: "suggest",
        inactivity: { enabled: true, nudgeAfter: 30, closeAfter: 1440, nudgeMessage: "Ainda por aí, @contact.name?" },
      },
    })]);
    await processIdleV2(NOW);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Ainda por aí, Ana?", autonomyMode: "DRAFT" }));
  });

  it("aviso não enviado (trava de repetição, canal): não conta e o turno fica sem resposta", async () => {
    mocks.queryRaw.mockResolvedValue([row()]);
    mocks.send.mockResolvedValue({ sent: false, reason: "duplicate" });
    expect(await processIdleV2(NOW)).toEqual({ nudged: 0, closed: 0 });
    expect(mocks.logTurn).toHaveBeenCalledTimes(1);
    expect(mocks.logTurn.mock.calls[0][0]).not.toHaveProperty("reply");
  });

  it("prazo de encerramento vencido após o aviso: encerra pelo motor (motivo inatividade) e registra encerrado", async () => {
    mocks.queryRaw.mockResolvedValue([row({
      last_out_content: NUDGE_MESSAGE_DEFAULT,
      last_out_at: minutesAgo(1500),
      last_inbound_at: minutesAgo(1600),
      theme_id: "t-1",
      simple_config: {
        name: "Agente",
        tone: "Objetivo",
        autonomyMode: "auto",
        themes: [{ id: "t-1", name: "Fatura", instructions: "x", when: ["fatura"] }],
        inactivity: { enabled: true, nudgeAfter: 30, closeAfter: 1440, closeMessage: "Vou encerrar por aqui." },
      },
    })]);
    expect(await processIdleV2(NOW)).toEqual({ nudged: 0, closed: 1 });
    // Fora da janela de 24h da última mensagem do cliente: não dá para mandar texto.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.closeState).toHaveBeenCalledTimes(1);
    const args = mocks.closeState.mock.calls[0] as unknown[];
    expect(args[0]).toBe("org-1");
    expect(args[1]).toBe("conv-1");
    expect(args[2]).toBe("agent-1");
    expect(args[3]).toBe("deal-1");
    expect(args[6]).toBe("inactivity");
    expect(args[7]).toBe("ct-1");
    expect(args[9]).toMatchObject({ id: "t-1", name: "Fatura" });
    expect(mocks.logTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "inactivity", closed: true, stage: "closed" }));
    expect(mocks.logTurn.mock.calls[0][0]).not.toHaveProperty("reply");
  });

  it("encerramento dentro das 24h: manda a mensagem de fecho antes de encerrar", async () => {
    mocks.queryRaw.mockResolvedValue([row({
      last_out_at: minutesAgo(70),
      last_inbound_at: minutesAgo(80),
      deal_id: null,
      simple_config: {
        name: "Agente",
        tone: "Objetivo",
        autonomyMode: "auto",
        inactivity: { enabled: true, nudgeAfter: 0, closeAfter: 60, closeMessage: "Vou encerrar por aqui, @contact.name." },
      },
    })]);
    expect(await processIdleV2(NOW)).toEqual({ nudged: 0, closed: 1 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Vou encerrar por aqui, Ana." }));
    expect(mocks.closeState).toHaveBeenCalledTimes(1);
    expect((mocks.closeState.mock.calls[0] as unknown[])[3]).toBeUndefined();
    expect(mocks.logTurn).toHaveBeenCalledWith(expect.objectContaining({ reply: "Vou encerrar por aqui, Ana.", closed: true }));
  });

  it("sem mensagem de fecho configurada: encerra em silêncio", async () => {
    mocks.queryRaw.mockResolvedValue([row({
      last_out_at: minutesAgo(70),
      last_inbound_at: minutesAgo(80),
      simple_config: { name: "Agente", tone: "Objetivo", inactivity: { enabled: true, nudgeAfter: 0, closeAfter: 60 } },
    })]);
    expect(await processIdleV2(NOW)).toEqual({ nudged: 0, closed: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.closeState).toHaveBeenCalledTimes(1);
  });

  it("ainda no prazo: não faz nada com a conversa", async () => {
    mocks.queryRaw.mockResolvedValue([row({ last_out_at: minutesAgo(10), last_inbound_at: minutesAgo(12) })]);
    expect(await processIdleV2(NOW)).toEqual({ nudged: 0, closed: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.closeState).not.toHaveBeenCalled();
    expect(mocks.logTurn).not.toHaveBeenCalled();
  });

  it("configuração inválida de um agente não trava a passada; falha numa conversa não trava as outras", async () => {
    mocks.queryRaw.mockResolvedValue([
      row({ conversation_id: "conv-bad", simple_config: { inactivity: "x" } }),
      row({ conversation_id: "conv-err" }),
      row({ conversation_id: "conv-ok" }),
    ]);
    mocks.send.mockImplementation(async (args) => {
      if (args.conversationId === "conv-err") throw new Error("canal fora do ar");
      return { sent: true };
    });
    expect(await processIdleV2(NOW)).toEqual({ nudged: 1, closed: 0 });
    expect(mocks.send.mock.calls.map((c) => c[0].conversationId)).toEqual(["conv-err", "conv-ok"]);
    expect(mocks.logTurn).toHaveBeenCalledTimes(1);
    expect(mocks.logTurn).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-ok" }));
  });

  it("consulta recebe o instante da passada como parâmetro", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    await processIdleV2(NOW);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][1]).toBe(NOW);
    const sql = String(mocks.queryRaw.mock.calls[0][0]);
    // Só conversas abertas cuja última mensagem enviada é do próprio agente,
    // com inatividade ligada, fora da fila de pessoas e não encerradas.
    expect(sql).toContain(`c."status" = 'OPEN'`);
    expect(sql).toContain(`last_out."aiAgentUserId" = c."assignedToId"`);
    expect(sql).toContain(`'inactivity'->>'enabled') = 'true'`);
    expect(sql).toContain(`s."owner" <> 'pessoa' AND s."stage" <> 'closed'`);
  });
});
