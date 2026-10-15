/**
 * Quais escritas do Prisma trocam a versão de card do board (rede de
 * segurança do ETag — `board-card-writes.ts`). Mensagem e dado fora do card
 * não trocam.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  isBoardCardWrite,
  noteBoardCardWrite,
  pendingBoardCardBumpsForTests,
  resetBoardCardWritesForTests,
} from "@/lib/board-card-writes";
import { runWithContext } from "@/lib/request-context";

afterEach(() => resetBoardCardWritesForTests());

describe("isBoardCardWrite", () => {
  it("negócio, tags do negócio, produtos, tarefas e etapas: qualquer escrita", () => {
    for (const model of ["Deal", "TagOnDeal", "DealProduct", "Activity", "Stage"]) {
      expect(isBoardCardWrite(model, "update", { data: { anything: 1 } })).toBe(true);
      expect(isBoardCardWrite(model, "create", { data: {} })).toBe(true);
      expect(isBoardCardWrite(model, "deleteMany", { where: {} })).toBe(true);
      expect(isBoardCardWrite(model, "findMany", {})).toBe(false);
    }
  });

  it("contato: só nome/e-mail/telefone/foto ou exclusão — nunca lastMessageAt", () => {
    expect(isBoardCardWrite("Contact", "update", { data: { name: "Ana" } })).toBe(true);
    expect(isBoardCardWrite("Contact", "update", { data: { avatarUrl: "x" } })).toBe(true);
    expect(isBoardCardWrite("Contact", "upsert", { create: { name: "A" }, update: { phone: "1" } })).toBe(true);
    expect(isBoardCardWrite("Contact", "delete", { where: { id: "c" } })).toBe(true);
    expect(
      isBoardCardWrite("Contact", "update", {
        data: { lastMessageAt: new Date(), lastMessageDirection: "in" },
      }),
    ).toBe(false);
    // Contato novo ainda não está em card nenhum (o negócio novo sobe a versão).
    expect(isBoardCardWrite("Contact", "create", { data: { name: "Novo" } })).toBe(false);
    expect(isBoardCardWrite("Contact", "upsert", { create: { name: "Novo" }, update: {} })).toBe(false);
  });

  it("dono, produto e tag: só os campos que o card mostra", () => {
    expect(isBoardCardWrite("User", "update", { data: { name: "B" } })).toBe(true);
    expect(isBoardCardWrite("User", "update", { data: { lastSeenAt: new Date() } })).toBe(false);
    expect(isBoardCardWrite("Product", "update", { data: { type: "SERVICE" } })).toBe(true);
    expect(isBoardCardWrite("Product", "update", { data: { stock: 3 } })).toBe(false);
    expect(isBoardCardWrite("Tag", "update", { data: { color: "#fff" } })).toBe(true);
    expect(isBoardCardWrite("Tag", "create", { data: { name: "nova" } })).toBe(false);
  });

  it("mensagens, conversas e eventos não são card", () => {
    for (const model of ["Message", "Conversation", "ActivityEvent", "ScheduledMessage"]) {
      expect(isBoardCardWrite(model, "create", { data: {} })).toBe(false);
      expect(isBoardCardWrite(model, "update", { data: { name: "x" } })).toBe(false);
    }
  });
});

describe("noteBoardCardWrite", () => {
  it("agenda um bump por org (coalescido) e ignora escrita sem org no contexto", () => {
    noteBoardCardWrite("Deal", "update", { data: { title: "x" } });
    expect(pendingBoardCardBumpsForTests()).toEqual([]);

    const ctx = { organizationId: "org-1", userId: "u", isSuperAdmin: false } as never;
    runWithContext(ctx, () => {
      noteBoardCardWrite("Deal", "update", { data: { title: "x" } });
      noteBoardCardWrite("Activity", "create", { data: { dealId: "d" } });
      noteBoardCardWrite("Message", "create", { data: {} });
    });
    expect(pendingBoardCardBumpsForTests()).toEqual(["org-1"]);
  });
});
