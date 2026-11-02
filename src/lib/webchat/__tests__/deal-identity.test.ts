/** Regras puras do vínculo por campo de negócio e da prioridade (§9.12). */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/webchat/conversation-notes", () => ({ createWebchatSiteNote: vi.fn() }));

import { activePriorityAt } from "@/lib/conversation-priority";
import {
  normalizeDealIdentityValue,
  pickIdentityDeal,
  separatedIdentityNoteText,
  type DealIdentityCandidate,
} from "@/lib/webchat/deal-identity";

const deal = (id: string, status: string, day: number, contactId: string | null = "ct-1"): DealIdentityCandidate => ({
  id,
  contactId,
  status,
  updatedAt: new Date(2026, 0, day),
});

describe("pickIdentityDeal", () => {
  it("aberto mais recente, mesmo com fechado mais novo", () => {
    const res = pickIdentityDeal([deal("a", "OPEN", 1), deal("b", "OPEN", 2), deal("c", "WON", 3)]);
    expect(res?.id).toBe("b");
  });

  it("sem aberto, o mais recente", () => {
    expect(pickIdentityDeal([deal("a", "LOST", 1), deal("b", "WON", 2)])?.id).toBe("b");
  });

  it("negócio com contato vem antes do sem contato", () => {
    expect(pickIdentityDeal([deal("a", "OPEN", 9, null), deal("b", "LOST", 1)])?.id).toBe("b");
  });

  it("só sem contato: devolve, para quem chama tratar", () => {
    expect(pickIdentityDeal([deal("a", "OPEN", 1, null)])?.contactId).toBeNull();
  });

  it("prefere o contato já ligado ao valor", () => {
    const res = pickIdentityDeal([deal("a", "OPEN", 9, "ct-2"), deal("b", "LOST", 1, "ct-1")], "ct-1");
    expect(res?.id).toBe("b");
  });

  it("vazio: nenhum", () => {
    expect(pickIdentityDeal([])).toBeNull();
  });
});

describe("normalizeDealIdentityValue", () => {
  const field = (normalize: "none" | "digits") =>
    ({ type: "dealCustomField", customFieldId: "f", normalize }) as const;

  it("none: só tira espaço das pontas", () => {
    expect(normalizeDealIdentityValue(" 12.3-a ", field("none"))).toBe("12.3-a");
  });

  it("digits: só os dígitos", () => {
    expect(normalizeDealIdentityValue("12.3-4", field("digits"))).toBe("1234");
  });

  it("digits sem dígito não identifica", () => {
    expect(normalizeDealIdentityValue("abc", field("digits"))).toBeNull();
  });
});

describe("activePriorityAt", () => {
  const at = new Date("2026-01-01");

  it("vale com a conversa aberta e sem resposta humana", () => {
    expect(activePriorityAt({ priorityAt: at, status: "OPEN", hasHumanReply: false })).toBe(at);
  });

  it("termina na primeira resposta humana", () => {
    expect(activePriorityAt({ priorityAt: at, status: "OPEN", hasHumanReply: true })).toBeNull();
  });

  it("termina ao encerrar", () => {
    expect(activePriorityAt({ priorityAt: at, status: "RESOLVED", hasHumanReply: false })).toBeNull();
  });

  it("sem prioridade: nada", () => {
    expect(activePriorityAt({ priorityAt: null, status: "OPEN", hasHumanReply: false })).toBeNull();
  });
});

it("nota de possível vínculo cita negócio e contato, sem o identificador", () => {
  const text = separatedIdentityNoteText({ dealLabel: "Negócio #7", ownerName: "Pessoa", ownerNumber: 3 });
  expect(text).toContain("Negócio #7");
  expect(text).toContain("Pessoa (#3)");
  expect(text).toContain("possível vínculo");
});
