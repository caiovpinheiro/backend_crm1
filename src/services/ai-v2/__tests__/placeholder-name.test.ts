import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { isPlaceholderContactName } from "../context";

describe("nome genérico no cadastro não é nome de pessoa", () => {
  it("rótulo, número ou palavra técnica: descartado", () => {
    for (const n of ["Negócio", "negocio", "Cliente", "Contato 123", "Lead", "Novo contato", "5511999990000", "+55 11 99999-0000", "WhatsApp", "-"]) {
      expect(isPlaceholderContactName(n), n).toBe(true);
    }
  });

  it("nome de pessoa (mesmo com uma dessas palavras dentro) continua", () => {
    for (const n of ["Ana Souza", "Clientina", "Leandro", "Maria Negócios Ltda", "João"]) {
      expect(isPlaceholderContactName(n), n).toBe(false);
    }
    expect(isPlaceholderContactName("")).toBe(false);
    expect(isPlaceholderContactName(null)).toBe(false);
  });
});
