/**
 * P-12 — orçamento de consultas de um `new_message`, do publisher até o
 * listener, com o snapshot do `card` e o escopo do board de verdade.
 *
 * Antes do contrato (DEV dfe240a4) o caminho fazia:
 *   - 1 `conversation.findFirst` (card do inbox) por evento;
 *   - 1 `$queryRaw` (contato → pipelines) no miss do cache de 60 s.
 * Anexar `pipelineIds`/`dealIds` ao evento NÃO pode somar consulta: os
 * números abaixo são os mesmos de antes. Se alguém adicionar uma consulta
 * por mensagem (para montar o evento ou o escopo), este teste falha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const calls: string[] = [];
  const state = {
    calls,
    scopeRows: [] as unknown[],
    conversationRow: null as unknown,
  };
  return state;
});

vi.mock("@/lib/prisma-base", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => async () => {
          h.calls.push(`${name}.${op}`);
          return name === "conversation" && op === "findFirst"
            ? h.conversationRow
            : null;
        },
      },
    );
  const models = new Map<string, unknown>();
  const prismaBase = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "$queryRaw") {
          return async () => {
            h.calls.push("$queryRaw");
            return h.scopeRows;
          };
        }
        if (prop.startsWith("$")) {
          return async () => {
            h.calls.push(prop);
            return null;
          };
        }
        if (!models.has(prop)) models.set(prop, model(prop));
        return models.get(prop);
      },
    },
  );
  return { prismaBase };
});

import { clearMessagePipelineCache } from "@/lib/board-invalidation";
import { publishNewMessage } from "@/lib/realtime-events";
import { sseBus } from "@/lib/sse-bus";

/** Consultas por `new_message` antes do P-12 — o teto que vale hoje. */
const QUERIES_ON_MISS = ["$queryRaw", "conversation.findFirst"];
const QUERIES_ON_HIT = ["conversation.findFirst"];

const NOW = new Date("2026-10-01T12:00:00.000Z");

function conversationRow(id: string) {
  return {
    id,
    number: 10,
    channel: "whatsapp",
    channelId: "chan-1",
    status: "OPEN",
    unreadCount: 1,
    hasError: false,
    hasHumanReply: false,
    hasAgentReply: false,
    lastInboundAt: NOW,
    lastMessageDirection: "in",
    closedAt: null,
    followUpAt: null,
    updatedAt: NOW,
    createdAt: NOW,
    assignedToId: null,
    departmentId: null,
    tabulationId: null,
    pinnedNoteId: null,
    whatsappCallConsentStatus: null,
    department: null,
    assignedTo: null,
    contact: {
      id: "contact-1",
      name: "Maria",
      email: null,
      phone: "5511999990000",
      avatarUrl: null,
      automationContexts: [],
    },
  };
}

const unsubs: Array<() => void> = [];

function listen(orgId: string) {
  const got: Array<Record<string, unknown>> = [];
  unsubs.push(
    sseBus.subscribe(
      { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
      (event, envelope) => {
        if (event === "new_message") got.push(envelope.data as Record<string, unknown>);
      },
    ),
  );
  return got;
}

function inbound(orgId: string, content: string) {
  publishNewMessage({
    organizationId: orgId,
    conversationId: "conv-1",
    contactId: "contact-1",
    direction: "in",
    assignedToId: null,
    content,
    timestamp: NOW,
  });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.calls.length = 0;
  h.scopeRows = [{ pipelineId: "pipe-1", dealCount: 1, dealIds: ["deal-1"] }];
  h.conversationRow = conversationRow("conv-1");
  clearMessagePipelineCache();
});

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.();
  vi.useRealTimers();
});

describe("new_message: consultas por mensagem não sobem com o escopo do board", () => {
  it("primeira mensagem do contato: card + contato→pipelines, nada além", async () => {
    const got = listen("org-b1");

    inbound("org-b1", "oi");
    await settle();

    expect([...h.calls].sort()).toEqual(QUERIES_ON_MISS);
    expect(got).toHaveLength(1);
    // O evento chega completo: card do inbox e escopo do board.
    expect(got[0].card).toMatchObject({ id: "conv-1", contact: { id: "contact-1" } });
    expect(got[0].pipelineIds).toEqual(["pipe-1"]);
    expect(got[0].dealIds).toEqual(["deal-1"]);
  });

  it("mensagens seguintes (cache de 60 s): só o card, e o escopo continua no evento", async () => {
    const got = listen("org-b2");
    inbound("org-b2", "oi");
    await settle();
    h.calls.length = 0;

    for (let i = 0; i < 5; i += 1) {
      inbound("org-b2", `msg ${i}`);
      await settle();
    }

    expect(h.calls).toEqual(Array(5).fill(QUERIES_ON_HIT[0]));
    expect(got).toHaveLength(6);
    for (const data of got) {
      expect(data.pipelineIds).toEqual(["pipe-1"]);
      expect(data.dealIds).toEqual(["deal-1"]);
    }
  });

  it("média por mensagem numa rajada de 20 do mesmo contato ≤ a de antes", async () => {
    listen("org-b3");

    for (let i = 0; i < 20; i += 1) {
      inbound("org-b3", `msg ${i}`);
      await settle();
    }

    // Antes: 20 cards + 1 contato→pipelines = 21 consultas.
    expect(h.calls).toHaveLength(21);
    expect(h.calls.filter((c) => c === "$queryRaw")).toHaveLength(1);
  });
});
