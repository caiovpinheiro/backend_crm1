/**
 * `conversations.lastMessageAt` — recorte (o mesmo da prévia do card) e as
 * duas escritas cruas: `touchInbound` e `touchConversationLastMessageAt`
 * nunca andam para trás.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executeRaw: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { $executeRaw: h.executeRaw } }));

import type { Prisma } from "@prisma/client";

import { touchInbound } from "@/lib/conversation-inbound";
import {
  NON_CHAT_MESSAGE_TYPES,
  chatMessageSqlFilter,
  isListChatMessage,
  lastMessageAtData,
  listChatMessageAt,
  touchChatLastMessageAt,
  touchConversationLastMessageAt,
} from "@/lib/conversation-last-message";

function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = call as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
  if (Array.isArray(first)) return { text: first.join("?"), values: rest };
  const sql = first as Prisma.Sql;
  return { text: sql.strings.join("?"), values: [...sql.values] };
}

beforeEach(() => {
  h.executeRaw.mockReset();
  h.executeRaw.mockResolvedValue(1);
});

describe("recorte de mensagem de chat", () => {
  it("conta entrada e saída públicas de qualquer tipo de chat", () => {
    for (const messageType of ["text", "image", "template", "interactive", "audio", "sip_call", undefined]) {
      expect(isListChatMessage({ direction: "in", messageType })).toBe(true);
      expect(isListChatMessage({ direction: "out", messageType })).toBe(true);
    }
  });

  it("não conta nota interna, rascunho da IA, ligação WhatsApp, evento nem sistema", () => {
    for (const messageType of NON_CHAT_MESSAGE_TYPES) {
      expect(isListChatMessage({ direction: "out", messageType })).toBe(false);
    }
    expect(isListChatMessage({ direction: "out", messageType: "event" })).toBe(false);
    expect(isListChatMessage({ direction: "out", messageType: "event:transfer" })).toBe(false);
    expect(isListChatMessage({ direction: "out", messageType: "text", isPrivate: true })).toBe(false);
    expect(isListChatMessage({ direction: "system", messageType: "text" })).toBe(false);
  });

  it("listChatMessageAt propõe o horário só no recorte; lastMessageAtData não atribui a coluna", () => {
    const createdAt = new Date("2026-10-03T10:00:00.000Z");
    expect(listChatMessageAt({ direction: "out", messageType: "text", createdAt })).toEqual(createdAt);
    expect(listChatMessageAt({ direction: "out", messageType: "note", isPrivate: true, createdAt })).toBeNull();
    expect(listChatMessageAt({ direction: "out", messageType: "ai_draft", createdAt })).toBeNull();
    expect(listChatMessageAt({ direction: "out", messageType: "event:transfer", createdAt })).toBeNull();
    expect(lastMessageAtData({ direction: "out", messageType: "text", createdAt })).toEqual({});
  });

  it("o predicado SQL (prévia do card) exclui exatamente os mesmos tipos", () => {
    const sql = chatMessageSqlFilter();
    const text = sql.strings.join("?");
    expect(text).toContain(`"isPrivate" = false`);
    expect(text).toContain(`"messageType" NOT LIKE 'event%'`);
    expect(text).toContain(`"direction" IN ('in', 'out')`);
    expect(sql.values).toEqual([...NON_CHAT_MESSAGE_TYPES]);
  });
});

describe("escritas cruas", () => {
  it("touchInbound grava lastMessageAt na MESMA instrução, com GREATEST (webhook atrasado não rebaixa)", async () => {
    const at = new Date("2026-10-03T10:00:00.000Z");
    await touchInbound({ conversationId: "conv-1", at });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf(h.executeRaw.mock.calls[0]!);
    expect(text).toMatch(/"lastMessageAt" = GREATEST\("lastMessageAt", \?\)/);
    expect(text).toMatch(/"lastInboundAt" = \?/);
    expect(values).toContain("conv-1");
  });

  it("touchConversationLastMessageAt só avança (GREATEST na linha)", async () => {
    const at = new Date("2026-10-03T10:00:00.000Z");
    await touchConversationLastMessageAt({ conversationId: "conv-2", at });
    const { text, values } = sqlOf(h.executeRaw.mock.calls[0]!);
    expect(text).toMatch(/SET "lastMessageAt" = GREATEST\("lastMessageAt", \?\)/);
    expect(text).not.toMatch(/SET "lastMessageAt" = \?/);
    expect(text).not.toMatch(/updatedAt/);
    expect(values).toEqual([at, "conv-2"]);
  });

  it("mensagem nova sobe, atrasada não desce, e dois horários concorrentes ficam no maior", () => {
    const current = new Date("2026-10-05T15:00:00.000Z");
    const late = new Date("2026-10-05T14:00:00.000Z");
    const next = new Date("2026-10-05T16:00:00.000Z");
    const apply = (row: Date | null, at: Date) =>
      row == null || at.getTime() > row.getTime() ? at : row;
    expect(apply(current, next)).toEqual(next);
    expect(apply(current, late)).toEqual(current);
    expect(apply(apply(current, late), next)).toEqual(next);
    expect(apply(apply(current, next), late)).toEqual(next);
  });

  it("nota, ai_draft e evento não escrevem lastMessageAt", async () => {
    const createdAt = new Date("2026-10-05T14:00:00.000Z");
    for (const messageType of ["note", "ai_draft", "event", "whatsapp_call"] as const) {
      await touchChatLastMessageAt({
        conversationId: "conv-3",
        message: { direction: "out", messageType, createdAt },
      });
    }
    await touchChatLastMessageAt({
      conversationId: "conv-3",
      message: { direction: "out", messageType: "text", isPrivate: true, createdAt },
    });
    expect(h.executeRaw).not.toHaveBeenCalled();
    await touchChatLastMessageAt({
      conversationId: "conv-3",
      message: { direction: "in", messageType: "text", createdAt },
    });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });
});
