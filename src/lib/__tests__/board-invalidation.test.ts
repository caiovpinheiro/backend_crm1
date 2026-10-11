/**
 * `new_message` → invalidação do board, sem Redis (fallback em memória)
 * e com o banco falso. Só o pipeline onde o contato tem deal é invalidado
 * (versão do pipeline trocada — o valor antigo deixa de ser lido), no
 * máximo uma vez a cada 60 s por pipeline (leading + trailing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return { queryRaw: vi.fn() };
});

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { $queryRaw: h.queryRaw },
}));

vi.mock("@/lib/inbox-sse-card", () => ({
  shouldAttachInboxSseCard: () => false,
  withInboxSseCard: async (_event: string, data: unknown) => data,
}));

import {
  clearMessagePipelineCache,
  PIPELINES_CACHE_TTL_MS,
} from "@/lib/board-invalidation";
import { cache } from "@/lib/cache";
import { BOARD_MESSAGE_INVALIDATION_WINDOW_MS, boardDataKey } from "@/lib/cache/keys";
import { sseBus } from "@/lib/sse-bus";

// Bem acima da janela de 60 s: o que some do cache aqui é purga, não TTL.
const TTL = 3_600;

async function seedBoards(orgId: string, ...pipelineIds: string[]) {
  for (const p of pipelineIds) {
    await cache.set(await boardDataKey(orgId, p, "v"), { pipeline: p }, TTL);
  }
}

async function cached(orgId: string, pipelineId: string) {
  return cache.get(await boardDataKey(orgId, pipelineId, "v"));
}

function newMessage(orgId: string, extra: Record<string, unknown> = {}) {
  sseBus.publish("new_message", {
    organizationId: orgId,
    conversationId: "conv-1",
    contactId: "contact-1",
    direction: "in",
    content: "oi",
    ...extra,
  });
}

/** Deixa a consulta do pipeline e a troca de versão (memória) terminarem. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.queryRaw.mockReset();
  clearMessagePipelineCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("board: invalidação por new_message", () => {
  it("mensagem de contato sem deal no pipeline aberto não invalida aquele board", async () => {
    await seedBoards("org-a", "pipe-open", "pipe-other");
    h.queryRaw.mockResolvedValueOnce([{ pipelineId: "pipe-other" }]);

    newMessage("org-a");
    await settle();

    expect(await cached("org-a", "pipe-open")).toEqual({ pipeline: "pipe-open" });
    expect(await cached("org-a", "pipe-other")).toBeUndefined();
  });

  it("contato sem deal nenhum não invalida board", async () => {
    await seedBoards("org-b", "pipe-1", "pipe-2");
    h.queryRaw.mockResolvedValueOnce([]);

    newMessage("org-b");
    await settle();

    expect(await cached("org-b", "pipe-1")).toBeDefined();
    expect(await cached("org-b", "pipe-2")).toBeDefined();
  });

  it("consulta filtra pela org e pelo contato do evento", async () => {
    h.queryRaw.mockResolvedValueOnce([]);

    newMessage("org-q", { contactId: "contact-42" });
    await settle();

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = h.queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain("FROM deals d");
    expect(sql).toContain('s."pipelineId"');
    expect(JSON.stringify(values)).toContain("org-q");
    expect(JSON.stringify(values)).toContain("contact-42");
  });

  it("pipelineId no evento apaga só aquele pipeline, sem consultar o banco", async () => {
    await seedBoards("org-c", "pipe-1", "pipe-2");

    newMessage("org-c", { pipelineId: "pipe-2" });
    await settle();

    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(await cached("org-c", "pipe-1")).toBeDefined();
    expect(await cached("org-c", "pipe-2")).toBeUndefined();
  });

  it("sem contato nem conversa no evento, apaga os boards da org", async () => {
    await seedBoards("org-d", "pipe-1", "pipe-2");

    sseBus.publish("new_message", { organizationId: "org-d", content: "oi" });
    await settle();

    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(await cached("org-d", "pipe-1")).toBeUndefined();
    expect(await cached("org-d", "pipe-2")).toBeUndefined();
  });

  it("consulta falhando apaga os boards da org", async () => {
    await seedBoards("org-e", "pipe-1", "pipe-2");
    h.queryRaw.mockRejectedValueOnce(new Error("db down"));

    newMessage("org-e");
    await settle();

    expect(await cached("org-e", "pipe-1")).toBeUndefined();
    expect(await cached("org-e", "pipe-2")).toBeUndefined();
  });

  it("apaga no máximo uma vez a cada 60 s por pipeline (leading + trailing)", async () => {
    expect(BOARD_MESSAGE_INVALIDATION_WINDOW_MS).toBe(60_000);
    h.queryRaw.mockResolvedValue([{ pipelineId: "pipe-1" }]);

    await seedBoards("org-f", "pipe-1");
    newMessage("org-f");
    await settle();
    expect(await cached("org-f", "pipe-1")).toBeUndefined();

    // Board recalculado; mais mensagens dentro da janela não apagam na hora
    // (antes a janela era de 15 s e aqui já teria havido o trailing).
    await seedBoards("org-f", "pipe-1");
    newMessage("org-f");
    await vi.advanceTimersByTimeAsync(3_000);
    newMessage("org-f");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await cached("org-f", "pipe-1")).toBeDefined();

    // Fim da janela: uma purga só, cobrindo as mensagens acumuladas.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await cached("org-f", "pipe-1")).toBeUndefined();
  });

  it("rajada de 3 min (1 mensagem a cada 2 s): ≤ 1 purga por minuto, e nenhuma depois que param", async () => {
    h.queryRaw.mockResolvedValue([{ pipelineId: "pipe-1" }]);
    await seedBoards("org-r", "pipe-1");

    let purges = 0;
    const checkPurge = async () => {
      if ((await cached("org-r", "pipe-1")) === undefined) {
        purges += 1;
        await seedBoards("org-r", "pipe-1");
      }
    };

    // 90 mensagens em 180 s.
    for (let t = 0; t < 180_000; t += 2_000) {
      newMessage("org-r", { content: `msg ${t}` });
      await settle();
      await checkPurge();
      await vi.advanceTimersByTimeAsync(2_000);
      await checkPurge();
    }
    // Leading em 0 s e trailing em 60/120/180 s. Com a janela de 15 s eram 12.
    expect(purges).toBeLessThanOrEqual(4);

    // Sem mensagem nova: no máximo o trailing pendente, depois nada.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(BOARD_MESSAGE_INVALIDATION_WINDOW_MS);
      await checkPurge();
    }
    expect(purges).toBeLessThanOrEqual(5);
    const settled = purges;
    await vi.advanceTimersByTimeAsync(5 * BOARD_MESSAGE_INVALIDATION_WINDOW_MS);
    await checkPurge();
    expect(purges).toBe(settled);
  });
});

describe("board: cache contato → pipelines (60 s por processo)", () => {
  it("mensagens seguidas do mesmo contato consultam o banco uma vez em 60 s", async () => {
    expect(PIPELINES_CACHE_TTL_MS).toBe(60_000);
    h.queryRaw.mockResolvedValue([{ pipelineId: "pipe-1" }]);

    await seedBoards("org-g", "pipe-1");
    newMessage("org-g");
    await settle();
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(await cached("org-g", "pipe-1")).toBeUndefined();

    // Mesmo contato, ainda dentro dos 60 s: sem consulta nova, purga
    // agendada (trailing) do mesmo jeito.
    await vi.advanceTimersByTimeAsync(20_000);
    await seedBoards("org-g", "pipe-1");
    newMessage("org-g");
    await settle();
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BOARD_MESSAGE_INVALIDATION_WINDOW_MS);
    expect(await cached("org-g", "pipe-1")).toBeUndefined();

    // Passados 60 s desde a consulta, o banco é consultado de novo.
    await vi.advanceTimersByTimeAsync(PIPELINES_CACHE_TTL_MS);
    newMessage("org-g");
    await settle();
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("contato sem deal também fica em cache (sem consulta a cada mensagem)", async () => {
    h.queryRaw.mockResolvedValue([]);
    await seedBoards("org-h", "pipe-1");

    newMessage("org-h");
    await settle();
    newMessage("org-h");
    await settle();

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(await cached("org-h", "pipe-1")).toBeDefined();
  });

  it("cache é por org e por contato", async () => {
    h.queryRaw.mockResolvedValue([]);

    newMessage("org-i", { contactId: "contact-1" });
    await settle();
    newMessage("org-i", { contactId: "contact-2" });
    await settle();
    newMessage("org-j", { contactId: "contact-1" });
    await settle();

    expect(h.queryRaw).toHaveBeenCalledTimes(3);
  });

  it("consulta falhando não entra no cache: a próxima mensagem tenta de novo", async () => {
    await seedBoards("org-k", "pipe-1", "pipe-2");
    h.queryRaw
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce([{ pipelineId: "pipe-1" }]);

    newMessage("org-k");
    await settle();
    expect(await cached("org-k", "pipe-1")).toBeUndefined();
    expect(await cached("org-k", "pipe-2")).toBeUndefined();

    await seedBoards("org-k", "pipe-1", "pipe-2");
    await vi.advanceTimersByTimeAsync(BOARD_MESSAGE_INVALIDATION_WINDOW_MS + 1);
    newMessage("org-k");
    await settle();
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect(await cached("org-k", "pipe-1")).toBeUndefined();
    expect(await cached("org-k", "pipe-2")).toBeDefined();
  });
});
