/**
 * `lookupStudent` passou a casar por RGM. A coluna já era importada; ela só
 * nunca tinha sido consultada — era por isso que o número informado no chat
 * não localizava ninguém.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { studentAcademicRecord: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

const { lookupStudent, canonicalRgm } = await import(
  "@/services/academic-records"
);

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  rgm: "12345678",
  cpf: null,
  nome: "Fulano",
  situacao: "EM CURSO",
  dataMatricula: null,
  ...over,
});

beforeEach(() => {
  findMany.mockReset();
});

describe("canonicalRgm", () => {
  it("tira máscara e caixa", () => {
    expect(canonicalRgm(" 12.345-678 ")).toBe("12345678");
    expect(canonicalRgm("AB123")).toBe("ab123");
  });

  it("vazio vira null", () => {
    expect(canonicalRgm("")).toBeNull();
    expect(canonicalRgm(null)).toBeNull();
    expect(canonicalRgm("  ")).toBeNull();
  });
});

describe("lookupStudent com RGM", () => {
  it("acha o registro pelo RGM informado", async () => {
    findMany.mockResolvedValueOnce([row()]);
    const out = await lookupStudent("org-1", { rgm: "12345678" });
    expect(out).toHaveLength(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("casa mesmo com máscara do lado de quem digitou", async () => {
    findMany.mockResolvedValueOnce([row()]);
    const out = await lookupStudent("org-1", { rgm: "12.345-678" });
    expect(out).toHaveLength(1);
  });

  it("valor parcial NÃO casa, mesmo que o banco devolva o candidato", async () => {
    // Trava o casamento exato: se o `equals` do Postgres afrouxar, o filtro
    // do lado do Node ainda barra.
    findMany.mockResolvedValueOnce([row({ rgm: "123456789" })]);
    const out = await lookupStudent("org-1", { rgm: "12345678" });
    expect(out).toHaveLength(0);
  });

  it("RGM vem ANTES do telefone: quem se identifica escolhe o registro", async () => {
    findMany.mockResolvedValueOnce([row()]);
    await lookupStudent("org-1", { rgm: "12345678", phone: "11999990000" });
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined();
    expect(JSON.stringify(where)).not.toContain("phone");
  });

  it("sem RGM, a ordem CPF -> telefone -> e-mail continua como era", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    await lookupStudent("org-1", { cpf: "12345678901", phone: "11999990000" });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      cpf: "12345678901",
    });
    expect(findMany.mock.calls[1][0].where).toMatchObject({
      phone: "11999990000",
    });
  });

  it("RGM que não acha cai para os outros critérios", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    const out = await lookupStudent("org-1", {
      rgm: "99999999",
      phone: "11999990000",
    });
    expect(out).toHaveLength(1);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
