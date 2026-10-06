/**
 * `conversations.lastMessageAt` — recorte (o mesmo da prévia do card) e as
 * duas escritas cruas: `touchInbound` e `touchConversationLastMessageAt`
 * nunca andam para trás. As duas gravam, em seguida, a última mensagem do
 * CONTATO (`contacts.lastMessageAt` / `lastMessageDirection`, Kanban — K1).
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
  carryContactLastMessage,
  touchChatLastMessageAt,
  touchContactLastMessage,
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
    // 1ª instrução: a conversa; 2ª: o contato dela (direção "in").
    expect(h.executeRaw).toHaveBeenCalledTimes(2);
    const { text, values } = sqlOf(h.executeRaw.mock.calls[0]!);
    expect(text).toMatch(/"lastMessageAt" = GREATEST\("lastMessageAt", \?\)/);
    expect(text).toMatch(/"lastInboundAt" = \?/);
    expect(values).toContain("conv-1");
    const contact = sqlOf(h.executeRaw.mock.calls[1]!);
    expect(contact.text).toMatch(/UPDATE contacts ct/);
    expect(contact.values).toEqual([at, "in", "conv-1", at]);
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
    // conversa + contato
    expect(h.executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(h.executeRaw.mock.calls[1]!).values).toEqual([createdAt, "in", "conv-3", createdAt]);
  });
});

describe("última mensagem do contato (Kanban)", () => {
  const at = new Date("2026-10-05T15:00:00.000Z");

  it("grava horário e direção do contato da conversa, sem tocar em updatedAt, com guarda monotônica", async () => {
    await touchContactLastMessage({ conversationId: "conv-9", at, direction: "out" });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf(h.executeRaw.mock.calls[0]!);
    expect(text).toMatch(/UPDATE contacts ct\s+SET "lastMessageAt" = \?,\s+"lastMessageDirection" = \?/);
    expect(text).toMatch(/FROM conversations cv\s+WHERE cv\.id = \?\s+AND ct\.id = cv\."contactId"/);
    // Mensagem atrasada não escreve nada: nem horário nem direção regridem.
    expect(text).toMatch(/AND \(ct\."lastMessageAt" IS NULL OR ct\."lastMessageAt" <= \?\)/);
    expect(text).not.toMatch(/updatedAt/);
    expect(values).toEqual([at, "out", "conv-9", at]);
  });

  it("guarda monotônica: mais nova sobe com a direção dela; atrasada não muda nada; empate vale a última gravação", () => {
    type Row = { at: Date | null; dir: string | null };
    const apply = (row: Row, msgAt: Date, dir: string): Row =>
      row.at == null || row.at.getTime() <= msgAt.getTime() ? { at: msgAt, dir } : row;
    const late = new Date("2026-10-05T14:00:00.000Z");
    const next = new Date("2026-10-05T16:00:00.000Z");
    expect(apply({ at: null, dir: null }, at, "in")).toEqual({ at, dir: "in" });
    expect(apply({ at, dir: "in" }, next, "out")).toEqual({ at: next, dir: "out" });
    expect(apply({ at, dir: "in" }, late, "out")).toEqual({ at, dir: "in" });
    expect(apply({ at, dir: "in" }, at, "out")).toEqual({ at, dir: "out" });
  });

  it("envio sem direção informada conta como nosso (out); mensagem de chat usa a direção dela", async () => {
    await touchConversationLastMessageAt({ conversationId: "conv-4", at });
    expect(sqlOf(h.executeRaw.mock.calls[1]!).values).toEqual([at, "out", "conv-4", at]);
    h.executeRaw.mockClear();
    await touchConversationLastMessageAt({ conversationId: "conv-4", at, direction: "in" });
    expect(sqlOf(h.executeRaw.mock.calls[1]!).values).toEqual([at, "in", "conv-4", at]);
    h.executeRaw.mockClear();
    await touchChatLastMessageAt({
      conversationId: "conv-4",
      message: { direction: "out", messageType: "template", createdAt: at },
    });
    expect(sqlOf(h.executeRaw.mock.calls[1]!).values).toEqual([at, "out", "conv-4", at]);
  });

  it("falha na gravação do contato não derruba o envio fora de transação", async () => {
    h.executeRaw.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("coluna ausente"));
    await expect(
      touchConversationLastMessageAt({ conversationId: "conv-5", at }),
    ).resolves.toBeUndefined();
    expect(h.executeRaw).toHaveBeenCalledTimes(2);
  });

  it("dentro de uma transação usa o MESMO cliente e o erro sobe (a transação já estaria abortada)", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("x")) };
    await expect(
      touchConversationLastMessageAt({ conversationId: "conv-6", at, tx: tx as never }),
    ).rejects.toThrow("x");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(h.executeRaw).not.toHaveBeenCalled();
  });
});

describe("fusão de contatos", () => {
  it("a última mensagem acompanha as conversas, só se for mais nova que a do contato que fica", async () => {
    await carryContactLastMessage({ fromContactId: "c-old", toContactId: "c-keep" });
    const { text, values } = sqlOf(h.executeRaw.mock.calls[0]!);
    expect(text).toMatch(/UPDATE contacts k/);
    expect(text).toMatch(/src\."lastMessageAt" IS NOT NULL/);
    expect(text).toMatch(/k\."lastMessageAt" IS NULL OR k\."lastMessageAt" < src\."lastMessageAt"/);
    expect(values).toEqual(["c-keep", "c-old"]);
  });
});
