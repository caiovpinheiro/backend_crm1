import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake do `conversation_turns` em memória, com as duas propriedades que
 * fazem a corretude do Turn Manager:
 *   - UNIQUE (organizationId, openKey) com NULLS DISTINCT — é ele que
 *     sustenta "no máximo um turno acumulando por conversa" e faz o ingest
 *     perdedor tomar P2002;
 *   - `updateMany` guardado por status — é assim que o claim atômico e a
 *     promoção evitam rodar duas vezes.
 * Sem esses dois comportamentos o teste passaria mesmo com o código errado.
 */
const ORG = "org-1";

type TurnRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  channel: string;
  status: string;
  openKey: string | null;
  messageIds: unknown;
  aggregatedText: string | null;
  debounceMs: number;
  maxWaitMs: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  readyAt: Date | null;
  claimedAt: Date | null;
  claimedBy: string | null;
  completedAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
};

type MessageRow = {
  id: string;
  organizationId: string;
  content: string | null;
  authorType: string;
  messageType: string;
};

// `vi.mock` é içado para o topo do arquivo, então tudo que as factories
// tocam precisa existir antes delas — daí o `vi.hoisted`.
const db = vi.hoisted(() => {
  const turns = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Record<string, unknown>>();
  const state = { seq: 0 };

  class UniqueViolation extends Error {
    code = "P2002";
  }

  function matches(
    row: Record<string, unknown>,
    where: Record<string, unknown> = {},
  ): boolean {
    for (const [key, cond] of Object.entries(where)) {
      const value = row[key];
      if (cond === null) {
        if (value !== null) return false;
        continue;
      }
      if (cond instanceof Date) {
        if (!(value instanceof Date) || value.getTime() !== cond.getTime()) {
          return false;
        }
        continue;
      }
      if (typeof cond === "object") {
        const c = cond as Record<string, unknown>;
        if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
        if ("lt" in c) {
          const limit = c.lt as Date;
          if (!(value instanceof Date) || value.getTime() >= limit.getTime()) {
            return false;
          }
        }
        if ("lte" in c) {
          const limit = c.lte as Date;
          if (!(value instanceof Date) || value.getTime() > limit.getTime()) {
            return false;
          }
        }
        continue;
      }
      if (value !== cond) return false;
    }
    return true;
  }

  function sortRows(
    rows: Record<string, unknown>[],
    orderBy?: Record<string, "asc" | "desc">,
  ) {
    if (!orderBy) return rows;
    const [key, dir] = Object.entries(orderBy)[0] ?? [];
    if (!key) return rows;
    return [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const an = av instanceof Date ? av.getTime() : 0;
      const bn = bv instanceof Date ? bv.getTime() : 0;
      return dir === "desc" ? bn - an : an - bn;
    });
  }

  const conversationTurn = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const openKey = (data.openKey as string | null) ?? null;
      if (openKey !== null) {
        for (const row of turns.values()) {
          if (
            row.organizationId === data.organizationId &&
            row.openKey === openKey
          ) {
            throw new UniqueViolation("Unique constraint failed");
          }
        }
      }
      state.seq += 1;
      const now = new Date();
      const row: Record<string, unknown> = {
        id: `turn-${state.seq}`,
        organizationId: data.organizationId,
        conversationId: data.conversationId,
        contactId: data.contactId ?? null,
        channel: data.channel ?? "meta",
        status: data.status ?? "RECEIVING",
        openKey,
        messageIds: data.messageIds ?? [],
        aggregatedText: null,
        debounceMs: data.debounceMs ?? 1500,
        maxWaitMs: data.maxWaitMs ?? 8000,
        firstMessageAt: data.firstMessageAt ?? now,
        lastMessageAt: data.lastMessageAt ?? now,
        readyAt: null,
        claimedAt: null,
        claimedBy: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        createdAt: now,
      };
      turns.set(row.id as string, row);
      return { ...row };
    },

    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = turns.get(where.id);
      return row ? { ...row } : null;
    },

    findFirst: async ({
      where,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, "asc" | "desc">;
    }) => {
      const rows = sortRows(
        [...turns.values()].filter((r) => matches(r, where)),
        orderBy,
      );
      return rows[0] ? { ...rows[0] } : null;
    },

    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, "asc" | "desc">;
      take?: number;
    }) => {
      const rows = sortRows(
        [...turns.values()].filter((r) => matches(r, where)),
        orderBy,
      );
      return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
    },

    updateMany: async ({
      where,
      data,
    }: {
      where?: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const hits = [...turns.values()].filter((r) => matches(r, where));
      for (const row of hits) {
        // O UNIQUE também vale no update: reabrir `openKey` enquanto outro
        // turno já acumula na mesma conversa tem que falhar.
        if (
          typeof data.openKey === "string" &&
          [...turns.values()].some(
            (o) =>
              o.id !== row.id &&
              o.organizationId === row.organizationId &&
              o.openKey === data.openKey,
          )
        ) {
          throw new UniqueViolation("Unique constraint failed");
        }
        Object.assign(row, data);
      }
      return { count: hits.length };
    },
  };

  const message = {
    findMany: async ({
      where,
    }: {
      where: { organizationId: string; id: { in: string[] } };
    }) =>
      where.id.in
        .map((id) => messages.get(id))
        .filter(
          (m): m is Record<string, unknown> =>
            Boolean(m) && m!.organizationId === where.organizationId,
        )
        .map((m) => ({ ...m })),
  };

  return { turns, messages, state, conversationTurn, message };
});

const turns = db.turns as unknown as Map<string, TurnRow>;
const messages = db.messages as unknown as Map<string, MessageRow>;

vi.mock("@/lib/prisma", () => ({
  prisma: { conversationTurn: db.conversationTurn, message: db.message },
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { conversationTurn: db.conversationTurn, message: db.message },
}));

vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: (data: Record<string, unknown>) => ({
    ...data,
    organizationId: "org-1",
  }),
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org-1",
  getRequestContext: () => ({ userId: "system", organizationId: "org-1" }),
}));

vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: async (_orgId: string, fn: () => Promise<void>) => fn(),
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSetting: vi.fn(async () => null),
}));

vi.mock("@/services/ai/phone-allowlist", () => ({
  isContactAllowedForAi: vi.fn(async () => true),
}));

const legacy = vi.hoisted(() => ({
  scheduleAiReply: vi.fn(async () => {}),
  claimInboundMessageForAi: vi.fn(async () => true),
  collectUnansweredInboundText: vi.fn(async () => ""),
}));

vi.mock("@/services/ai/inbound-debounce", () => legacy);

const agent = vi.hoisted(() => ({
  // Assinatura explícita: sem ela `mock.calls[0][0]` não tipa e as
  // asserções sobre o texto agregado viram `any`.
  maybeReplyAsAIAgent: vi.fn(
    async (_args: {
      conversationId: string;
      contactId: string;
      userMessage: string;
      channel: string;
      inboundMessageIds?: string[];
      turnId?: string;
    }) => {},
  ),
}));

vi.mock("@/services/ai/inbox-handler", () => agent);

import {
  appendToOpenTurn,
  buildAggregatedText,
  claimTurn,
  invalidateOpenTurns,
  isTurnDue,
  onInboundMessageForAi,
  promoteTurnToReady,
  turnDueAt,
} from "@/services/ai/turn-manager";
import { sweepConversationTurns } from "@/services/ai/turn-sweeper";

const { maybeReplyAsAIAgent } = agent;
const { scheduleAiReply, claimInboundMessageForAi } = legacy;

const CONV = "conv-1";
const CONTACT = "contact-1";

function addMessage(id: string, content: string, over: Partial<MessageRow> = {}) {
  messages.set(id, {
    id,
    organizationId: ORG,
    content,
    authorType: "contact",
    messageType: "text",
    ...over,
  });
  return id;
}

/** Ingere uma bolha do cliente no instante atual do relógio falso. */
async function ingest(id: string, content: string) {
  addMessage(id, content);
  return appendToOpenTurn({
    conversationId: CONV,
    contactId: CONTACT,
    messageId: id,
    userMessage: content,
    channel: "meta",
  });
}

function openTurns() {
  return [...turns.values()].filter((t) =>
    ["RECEIVING", "STABILIZING", "READY"].includes(t.status),
  );
}

function firstTurn() {
  return turns.get([...turns.keys()][0])!;
}

beforeEach(() => {
  turns.clear();
  messages.clear();
  db.state.seq = 0;
  vi.clearAllMocks();
  claimInboundMessageForAi.mockResolvedValue(true);
  legacy.collectUnansweredInboundText.mockResolvedValue("");
  maybeReplyAsAIAgent.mockResolvedValue(undefined);
  process.env.AI_TURN_MANAGER = "1";
  // O loop do sweeper é irrelevante aqui: os testes chamam o tick à mão.
  process.env.AI_TURN_SWEEPER = "0";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AI_TURN_MANAGER;
  delete process.env.AI_TURN_SWEEPER;
});

describe("agregação de mensagens em turno", () => {
  it("uma mensagem abre um turno e gera um único run", async () => {
    await ingest("m1", "Oi");
    expect(turns.size).toBe(1);

    vi.advanceTimersByTime(1500);
    const res = await sweepConversationTurns();

    expect(res.promoted).toBe(1);
    expect(res.dispatched).toBe(1);
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(1);
    expect(maybeReplyAsAIAgent.mock.calls[0][0]).toMatchObject({
      conversationId: CONV,
      userMessage: "Oi",
    });
  });

  it("cinco bolhas rápidas viram UM turno, com os ids e o texto na ordem", async () => {
    const bolhas: [string, string][] = [
      ["m1", "Oi"],
      ["m2", "preciso"],
      ["m3", "de ajuda"],
      ["m4", "com minha"],
      ["m5", "matrícula"],
    ];
    for (const [id, text] of bolhas) {
      await ingest(id, text);
      vi.advanceTimersByTime(200);
    }

    expect(turns.size).toBe(1);
    expect(firstTurn().messageIds).toEqual(["m1", "m2", "m3", "m4", "m5"]);

    vi.advanceTimersByTime(1500);
    await sweepConversationTurns();

    // As Messages continuam individuais no banco — o turno só referencia.
    expect(messages.size).toBe(5);
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(1);
    expect(maybeReplyAsAIAgent.mock.calls[0][0].userMessage).toBe(
      "Oi\npreciso\nde ajuda\ncom minha\nmatrícula",
    );
    expect(maybeReplyAsAIAgent.mock.calls[0][0].inboundMessageIds).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
  });

  it("mensagens espaçadas geram turnos separados", async () => {
    await ingest("m1", "Oi");
    vi.advanceTimersByTime(1500);
    await sweepConversationTurns();

    await ingest("m2", "outra dúvida");
    vi.advanceTimersByTime(1500);
    await sweepConversationTurns();

    expect(turns.size).toBe(2);
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(2);
    expect(maybeReplyAsAIAgent.mock.calls[1][0].userMessage).toBe("outra dúvida");
  });

  it("nova bolha reabre o turno que já estava READY (input não se perde)", async () => {
    await ingest("m1", "Oi");
    vi.advanceTimersByTime(1500);

    const turnId = firstTurn().id;
    await promoteTurnToReady(turnId, ORG);
    expect(turns.get(turnId)!.status).toBe("READY");

    await ingest("m2", "esqueci de dizer");

    const turn = turns.get(turnId)!;
    expect(turn.status).toBe("RECEIVING");
    expect(turn.readyAt).toBeNull();
    expect(turn.messageIds).toEqual(["m1", "m2"]);
  });

  it("texto agregado ignora bolhas do bot e notas internas", async () => {
    addMessage("m1", "Oi");
    addMessage("m2", "resposta do agente", { authorType: "bot" });
    addMessage("m3", "nota interna", { messageType: "note" });
    addMessage("m4", "com minha matrícula");

    const text = await buildAggregatedText(ORG, ["m1", "m2", "m3", "m4"]);
    expect(text).toBe("Oi\ncom minha matrícula");
  });
});

describe("janelas de debounce", () => {
  it("cada bolha reseta a janela de 1500ms", async () => {
    await ingest("m1", "Oi");

    vi.advanceTimersByTime(1400);
    expect(isTurnDue(firstTurn(), Date.now())).toBe(false);

    await ingest("m2", "preciso");
    vi.advanceTimersByTime(1400);
    expect(isTurnDue(firstTurn(), Date.now())).toBe(false);

    vi.advanceTimersByTime(200);
    expect(isTurnDue(firstTurn(), Date.now())).toBe(true);
  });

  it("MAX_WAIT de 8s libera o turno mesmo com o cliente digitando sem parar", async () => {
    const start = Date.now();
    await ingest("m0", "mensagem 0");

    // Uma bolha por segundo: o debounce de 1.5s nunca vence sozinho.
    for (let i = 1; i <= 8; i += 1) {
      vi.advanceTimersByTime(1000);
      await ingest(`m${i}`, `mensagem ${i}`);
    }

    expect(turnDueAt(firstTurn())).toBe(start + 8000);
    expect(isTurnDue(firstTurn(), Date.now())).toBe(true);

    const res = await sweepConversationTurns();
    expect(res.promoted).toBe(1);
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(1);
  });
});

describe("concorrência", () => {
  it("dois workers disputam o mesmo turno e só um processa", async () => {
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(turnId, ORG);

    const [a, b] = await Promise.all([
      claimTurn(turnId, ORG, "worker-a"),
      claimTurn(turnId, ORG, "worker-b"),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(turns.get(turnId)!.status).toBe("PROCESSING");
  });

  it("dois ingests simultâneos não abrem dois turnos na mesma conversa", async () => {
    addMessage("m1", "Oi");
    addMessage("m2", "preciso");

    await Promise.all([
      appendToOpenTurn({
        conversationId: CONV,
        contactId: CONTACT,
        messageId: "m1",
        userMessage: "Oi",
        channel: "meta",
      }),
      appendToOpenTurn({
        conversationId: CONV,
        contactId: CONTACT,
        messageId: "m2",
        userMessage: "preciso",
        channel: "meta",
      }),
    ]);

    expect(openTurns()).toHaveLength(1);
    expect(turns.size).toBe(1);
  });

  it("mensagem que chega durante PROCESSING abre um turno novo", async () => {
    await ingest("m1", "Oi");
    const first = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(first, ORG);
    await claimTurn(first, ORG, "worker-a");

    await ingest("m2", "esqueci de dizer");

    expect(turns.size).toBe(2);
    // O turno em voo não foi contaminado.
    expect(turns.get(first)!.messageIds).toEqual(["m1"]);
    const novo = [...turns.values()].find((t) => t.id !== first)!;
    expect(novo.messageIds).toEqual(["m2"]);
    expect(novo.status).toBe("RECEIVING");
  });

  it("promoção concorrente materializa o turno uma vez só", async () => {
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);

    const results = await Promise.all([
      promoteTurnToReady(turnId, ORG),
      promoteTurnToReady(turnId, ORG),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("resiliência", () => {
  it("turno READY órfão de um processo morto é recuperado pelo sweeper", async () => {
    // Simula restart: a linha existe, nenhum timer em memória aponta pra ela.
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(turnId, ORG);

    const res = await sweepConversationTurns();

    expect(res.dispatched).toBe(1);
    expect(turns.get(turnId)!.status).toBe("COMPLETED");
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(1);
  });

  it("PROCESSING travado é recuperado e reprocessado no mesmo tick", async () => {
    // Worker que claimou e morreu antes de terminar (deploy, OOM, SIGKILL).
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(turnId, ORG);
    await claimTurn(turnId, ORG, "worker-morto");
    expect(maybeReplyAsAIAgent).not.toHaveBeenCalled();

    // Passa do teto de PROCESSING (AI_TURN_STALE_MS, default 120s).
    vi.advanceTimersByTime(130_000);
    const res = await sweepConversationTurns({ limit: 10 });

    // O tick devolve o turno para READY (attempts++) e, na etapa de
    // dispatch do MESMO tick, um worker vivo claima e processa.
    expect(res.reclaimed).toBe(1);
    expect(res.dispatched).toBe(1);

    const turn = turns.get(turnId)!;
    expect(turn.attempts).toBe(1);
    expect(turn.status).toBe("COMPLETED");
    expect(turn.claimedBy).not.toBe("worker-morto");
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(1);
  });

  it("stale reclaim não rouba turno de worker que ainda está no prazo", async () => {
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(turnId, ORG);
    await claimTurn(turnId, ORG, "worker-vivo");

    // Abaixo do teto: o dono legítimo continua com o turno.
    vi.advanceTimersByTime(60_000);
    const res = await sweepConversationTurns({ limit: 10 });

    expect(res.reclaimed).toBe(0);
    const turn = turns.get(turnId)!;
    expect(turn.status).toBe("PROCESSING");
    expect(turn.claimedBy).toBe("worker-vivo");
    expect(turn.attempts).toBe(0);
  });

  it("turno venenoso vira FAILED no teto de tentativas, sem loop eterno", async () => {
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(turnId, ORG);
    await claimTurn(turnId, ORG, "worker-morto");
    turns.get(turnId)!.attempts = 2; // AI_TURN_MAX_ATTEMPTS default = 3

    vi.advanceTimersByTime(130_000);
    const res = await sweepConversationTurns({ limit: 10 });

    expect(res.failed).toBe(1);
    expect(turns.get(turnId)!.status).toBe("FAILED");
  });

  it("falha do agente devolve o turno para READY e o retry roda", async () => {
    maybeReplyAsAIAgent.mockRejectedValueOnce(new Error("LLM fora do ar"));

    await ingest("m1", "Oi");
    vi.advanceTimersByTime(1500);
    await sweepConversationTurns();

    const turnId = firstTurn().id;
    const turn = turns.get(turnId)!;
    expect(turn.status).toBe("READY");
    expect(turn.attempts).toBe(1);
    expect(turn.lastError).toContain("LLM fora do ar");

    await sweepConversationTurns();
    expect(turns.get(turnId)!.status).toBe("COMPLETED");
    expect(maybeReplyAsAIAgent).toHaveBeenCalledTimes(2);
  });
});

describe("cancelamento", () => {
  it("humano assumindo invalida o turno acumulando", async () => {
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;

    const count = await invalidateOpenTurns(CONV, "human_outbound");

    expect(count).toBe(1);
    const turn = turns.get(turnId)!;
    expect(turn.status).toBe("INVALIDATED");
    expect(turn.openKey).toBeNull();

    vi.advanceTimersByTime(1500);
    await sweepConversationTurns();
    expect(maybeReplyAsAIAgent).not.toHaveBeenCalled();
  });

  it("turno já em PROCESSING não é abortado pelo cancelamento", async () => {
    await ingest("m1", "Oi");
    const turnId = firstTurn().id;
    vi.advanceTimersByTime(1500);
    await promoteTurnToReady(turnId, ORG);
    await claimTurn(turnId, ORG, "worker-a");

    const count = await invalidateOpenTurns(CONV, "human_outbound");

    // A barreira desse caso é o assertAiStillAuthorized, imediatamente
    // antes do envio — não este cancelamento.
    expect(count).toBe(0);
    expect(turns.get(turnId)!.status).toBe("PROCESSING");
  });
});

describe("entrypoint de ingestão", () => {
  it("com a flag desligada delega para o debounce legado", async () => {
    process.env.AI_TURN_MANAGER = "0";
    addMessage("m1", "Oi");

    await onInboundMessageForAi({
      conversationId: CONV,
      contactId: CONTACT,
      messageId: "m1",
      userMessage: "Oi",
      channel: "meta",
    });

    expect(scheduleAiReply).toHaveBeenCalledTimes(1);
    expect(turns.size).toBe(0);
  });

  it("com a flag ligada abre turno e não toca no debounce legado", async () => {
    addMessage("m1", "Oi");

    await onInboundMessageForAi({
      conversationId: CONV,
      contactId: CONTACT,
      messageId: "m1",
      userMessage: "Oi",
      channel: "meta",
    });

    expect(scheduleAiReply).not.toHaveBeenCalled();
    expect(turns.size).toBe(1);
  });

  it("mensagem já reivindicada por outro processo não abre turno", async () => {
    claimInboundMessageForAi.mockResolvedValueOnce(false);
    addMessage("m1", "Oi");

    await onInboundMessageForAi({
      conversationId: CONV,
      contactId: CONTACT,
      messageId: "m1",
      userMessage: "Oi",
      channel: "meta",
    });

    expect(turns.size).toBe(0);
  });
});
