/**
 * `new_message` → invalidação do board, sem Redis (fallback em memória)
 * e com o banco falso. Só o pipeline onde o contato tem deal é apagado,
 * no máximo uma vez a cada 15 s por pipeline (leading + trailing).
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

import { cache } from "@/lib/cache";
import { BOARD_INVALIDATION_WINDOW_MS, boardDataKey } from "@/lib/cache/keys";
import { sseBus } from "@/lib/sse-bus";

const TTL = 45;

async function seedBoards(orgId: string, ...pipelineIds: string[]) {
  for (const p of pipelineIds) {
    await cache.set(boardDataKey(orgId, p, "v"), { pipeline: p }, TTL);
  }
}

async function cached(orgId: string, pipelineId: string) {
  return cache.get(boardDataKey(orgId, pipelineId, "v"));
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

/** Deixa a consulta do pipeline e o delPattern (memória) terminarem. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.queryRaw.mockReset();
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

  it("apaga no máximo uma vez a cada 15 s por pipeline (leading + trailing)", async () => {
    expect(BOARD_INVALIDATION_WINDOW_MS).toBe(15_000);
    h.queryRaw.mockResolvedValue([{ pipelineId: "pipe-1" }]);

    await seedBoards("org-f", "pipe-1");
    newMessage("org-f");
    await settle();
    expect(await cached("org-f", "pipe-1")).toBeUndefined();

    // Board recalculado; mais mensagens dentro da janela não apagam na hora.
    await seedBoards("org-f", "pipe-1");
    newMessage("org-f");
    await vi.advanceTimersByTimeAsync(3_000);
    newMessage("org-f");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await cached("org-f", "pipe-1")).toBeDefined();

    // Fim da janela: uma purga só, cobrindo as mensagens acumuladas.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await cached("org-f", "pipe-1")).toBeUndefined();
  });
});
