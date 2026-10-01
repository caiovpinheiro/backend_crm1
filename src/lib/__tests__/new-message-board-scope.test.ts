/**
 * P-12 — `new_message` leva o escopo do board (`pipelineIds` / `dealIds`).
 *
 * A MESMA resolução (cache contato → pipelines de 60 s, ou uma consulta)
 * que decide a purga do cache do board devolve o escopo que o barramento
 * anexa ao evento. A contagem de consultas por mensagem é a de antes:
 * 1 no miss, 0 no hit, 0 quando o chamador informa os pipelines.
 *
 * Sem Redis (fallback em memória), banco falso, relógio falso. O snapshot
 * do `card` fica de fora aqui; o orçamento do caminho inteiro (card +
 * escopo) está em `new-message-query-budget.test.ts`.
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
  BOARD_SCOPE_DEAL_IDS_PER_PIPELINE,
  BOARD_SCOPE_MAX_DEAL_IDS,
  clearMessagePipelineCache,
} from "@/lib/board-invalidation";
import { cache } from "@/lib/cache";
import { boardDataKey } from "@/lib/cache/keys";
import { publishMessageStatus, publishNewMessage } from "@/lib/realtime-events";
import { sseBus } from "@/lib/sse-bus";
import { redactNewMessageForUnlisted } from "@/lib/sse-redact";

const unsubs: Array<() => void> = [];

function listen(orgId: string) {
  const got: Array<Record<string, unknown>> = [];
  unsubs.push(
    sseBus.subscribe(
      { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
      (_event, envelope) => got.push(envelope.data as Record<string, unknown>),
    ),
  );
  return got;
}

function newMessage(orgId: string, extra: Record<string, unknown> = {}) {
  publishNewMessage({
    organizationId: orgId,
    conversationId: "conv-1",
    contactId: "contact-1",
    direction: "in",
    content: "oi",
    ...extra,
  });
}

async function seedBoards(orgId: string, ...pipelineIds: string[]) {
  for (const p of pipelineIds) {
    await cache.set(await boardDataKey(orgId, p, "v"), { pipeline: p }, 45);
  }
}

async function cached(orgId: string, pipelineId: string) {
  return cache.get(await boardDataKey(orgId, pipelineId, "v"));
}

/** Deixa a resolução do escopo e o fan-out terminarem. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.queryRaw.mockReset();
  clearMessagePipelineCache();
});

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.();
  vi.useRealTimers();
});

describe("new_message: escopo do board no evento", () => {
  it("miss: uma consulta, e o evento sai com os pipelines e os deals do contato", async () => {
    const got = listen("org-s1");
    h.queryRaw.mockResolvedValueOnce([
      { pipelineId: "pipe-1", dealCount: 2, dealIds: ["deal-1", "deal-2"] },
      { pipelineId: "pipe-2", dealCount: 1, dealIds: ["deal-3"] },
    ]);

    newMessage("org-s1");
    await settle();

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(got).toEqual([
      {
        organizationId: "org-s1",
        conversationId: "conv-1",
        contactId: "contact-1",
        direction: "in",
        content: "oi",
        pipelineIds: ["pipe-1", "pipe-2"],
        dealIds: ["deal-1", "deal-2", "deal-3"],
      },
    ]);
  });

  it("a consulta agrupa por pipeline e limita os ids por pipeline", async () => {
    h.queryRaw.mockResolvedValueOnce([]);

    newMessage("org-s2");
    await settle();

    const [strings, ...values] = h.queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain("FROM deals d");
    expect(sql).toContain('GROUP BY s."pipelineId"');
    expect(sql).toContain(`[1:${BOARD_SCOPE_DEAL_IDS_PER_PIPELINE}]`);
    expect(JSON.stringify(values)).toContain("org-s2");
    expect(JSON.stringify(values)).toContain("contact-1");
  });

  it("hit: 10 mensagens do mesmo contato = 1 consulta, todas com o escopo", async () => {
    const got = listen("org-s3");
    h.queryRaw.mockResolvedValue([
      { pipelineId: "pipe-1", dealCount: 1, dealIds: ["deal-1"] },
    ]);

    for (let i = 0; i < 10; i += 1) {
      newMessage("org-s3", { content: `msg ${i}` });
      await settle();
    }

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(got).toHaveLength(10);
    for (const data of got) {
      expect(data.pipelineIds).toEqual(["pipe-1"]);
      expect(data.dealIds).toEqual(["deal-1"]);
    }
  });

  it("chamador informa pipelineIds/dealIds: nenhuma consulta e só aquele board é purgado", async () => {
    const got = listen("org-s4");
    await seedBoards("org-s4", "pipe-1", "pipe-2");

    newMessage("org-s4", { pipelineIds: ["pipe-2"], dealIds: ["deal-9"] });
    await settle();

    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(got[0].pipelineIds).toEqual(["pipe-2"]);
    expect(got[0].dealIds).toEqual(["deal-9"]);
    expect(await cached("org-s4", "pipe-1")).toBeDefined();
    expect(await cached("org-s4", "pipe-2")).toBeUndefined();
  });

  it("contato sem deal: pipelineIds vazio (nenhum board afetado) e nada é purgado", async () => {
    const got = listen("org-s5");
    await seedBoards("org-s5", "pipe-1");
    h.queryRaw.mockResolvedValueOnce([]);

    newMessage("org-s5");
    await settle();

    expect(got[0].pipelineIds).toEqual([]);
    expect(got[0].dealIds).toEqual([]);
    expect(await cached("org-s5", "pipe-1")).toBeDefined();
  });

  it("lista de deals incompleta no pipeline: o evento leva só pipelineIds", async () => {
    const got = listen("org-s6");
    h.queryRaw.mockResolvedValueOnce([
      {
        pipelineId: "pipe-1",
        // 400 deals no pipeline, só os 25 primeiros ids vieram.
        dealCount: 400,
        dealIds: Array.from(
          { length: BOARD_SCOPE_DEAL_IDS_PER_PIPELINE },
          (_, i) => `deal-${i}`,
        ),
      },
    ]);

    newMessage("org-s6");
    await settle();

    expect(got[0].pipelineIds).toEqual(["pipe-1"]);
    expect(got[0]).not.toHaveProperty("dealIds");
  });

  it("mais deals que o teto do evento: só pipelineIds", async () => {
    const got = listen("org-s7");
    const perPipeline = 20;
    const pipelines = ["pipe-1", "pipe-2", "pipe-3"];
    expect(perPipeline * pipelines.length).toBeGreaterThan(BOARD_SCOPE_MAX_DEAL_IDS);
    h.queryRaw.mockResolvedValueOnce(
      pipelines.map((pipelineId) => ({
        pipelineId,
        dealCount: perPipeline,
        dealIds: Array.from({ length: perPipeline }, (_, i) => `${pipelineId}-deal-${i}`),
      })),
    );

    newMessage("org-s7");
    await settle();

    expect(got[0].pipelineIds).toEqual(pipelines);
    expect(got[0]).not.toHaveProperty("dealIds");
  });

  it("consulta falhando: o evento sai sem escopo (cliente usa o caminho antigo)", async () => {
    const got = listen("org-s8");
    h.queryRaw.mockRejectedValueOnce(new Error("db down"));

    newMessage("org-s8");
    await settle();

    expect(got).toEqual([
      {
        organizationId: "org-s8",
        conversationId: "conv-1",
        contactId: "contact-1",
        direction: "in",
        content: "oi",
      },
    ]);
  });

  it("consulta presa além do orçamento: o evento sai mesmo assim, sem escopo", async () => {
    const got = listen("org-s9");
    h.queryRaw.mockReturnValueOnce(new Promise(() => {}));

    newMessage("org-s9");
    await settle();
    expect(got).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(got).toHaveLength(1);
    expect(got[0]).not.toHaveProperty("pipelineIds");
    expect(got[0].content).toBe("oi");
  });

  it("outros eventos não consultam o banco nem ganham escopo", async () => {
    const got = listen("org-s10");

    publishMessageStatus({
      organizationId: "org-s10",
      conversationId: "conv-1",
      messageId: "m1",
      status: "read",
    });
    await settle();

    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(got).toEqual([
      {
        organizationId: "org-s10",
        conversationId: "conv-1",
        messageId: "m1",
        status: "read",
      },
    ]);
  });

  it("quem não lista a conversa continua recebendo o escopo (só ids, sem texto)", () => {
    expect(
      redactNewMessageForUnlisted({
        organizationId: "org-s11",
        conversationId: "conv-1",
        contactId: "contact-1",
        direction: "in",
        content: "segredo",
        senderName: "Ana",
        pipelineIds: ["pipe-1"],
        dealIds: ["deal-1"],
      }),
    ).toEqual({
      organizationId: "org-s11",
      conversationId: "conv-1",
      contactId: "contact-1",
      direction: "in",
      pipelineIds: ["pipe-1"],
      dealIds: ["deal-1"],
    });
  });
});
