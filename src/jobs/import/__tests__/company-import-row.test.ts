import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ company: { findMany: vi.fn() } }));
const svc = vi.hoisted(() => ({
  createCompany: vi.fn(),
  updateCompany: vi.fn(),
  findCompanyByNumber: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/storage/local", () => ({ readStoredFile: vi.fn() }));
vi.mock("@/services/companies", async (orig) => {
  const real = await orig<typeof import("@/services/companies")>();
  return { ...real, ...svc };
});

import { CompanyNumberConflictError } from "@/services/companies";
import { importCompanyRow } from "../company-import.job";

const ALL = new Set(["number", "name", "domain", "phone", "city"]);

describe("importCompanyRow — identificação de duplicadas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.company.findMany.mockResolvedValue([]);
    svc.findCompanyByNumber.mockResolvedValue(null);
    svc.createCompany.mockResolvedValue({ id: "new" });
    svc.updateCompany.mockResolvedValue({ id: "x" });
  });

  it("sem nome → falha na linha", async () => {
    const r = await importCompanyRow({ name: "" }, ALL, true);
    expect(r).toEqual({ kind: "failed", message: "Nome é obrigatório." });
  });

  it("número inválido → falha na linha com o valor", async () => {
    const r = await importCompanyRow({ name: "Acme", number: "12a" }, ALL, true);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.message).toContain('"12a"');
    expect(svc.createCompany).not.toHaveBeenCalled();
  });

  it("com número: casa SÓ pelo número — não consulta por nome", async () => {
    svc.findCompanyByNumber.mockResolvedValue({ id: "c7", number: 7, name: "Outro nome" });
    const r = await importCompanyRow({ name: "Acme", number: "7", city: "SP" }, ALL, true);
    expect(r).toEqual({ kind: "updated" });
    expect(db.company.findMany).not.toHaveBeenCalled();
    expect(svc.updateCompany).toHaveBeenCalledWith("c7", { name: "Acme", city: "SP" });
  });

  it("com número inexistente: cria com aquele número mesmo havendo empresa de mesmo nome", async () => {
    const r = await importCompanyRow({ name: "Acme", number: "1001" }, ALL, true);
    expect(r).toEqual({ kind: "created" });
    expect(db.company.findMany).not.toHaveBeenCalled();
    expect(svc.createCompany).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme", number: 1001 }),
    );
  });

  it("existente sem 'atualizar existentes' → ignorada, nada gravado", async () => {
    svc.findCompanyByNumber.mockResolvedValue({ id: "c7", number: 7, name: "Acme" });
    expect(await importCompanyRow({ name: "Acme", number: "7" }, ALL, false)).toEqual({
      kind: "skipped",
    });
    db.company.findMany.mockResolvedValue([{ id: "c1" }]);
    expect(await importCompanyRow({ name: "Acme" }, ALL, false)).toEqual({ kind: "skipped" });
    expect(svc.updateCompany).not.toHaveBeenCalled();
    expect(svc.createCompany).not.toHaveBeenCalled();
  });

  it("sem número e nome único → atualiza essa empresa", async () => {
    db.company.findMany.mockResolvedValue([{ id: "c1" }]);
    expect(await importCompanyRow({ name: "acme" }, ALL, true)).toEqual({ kind: "updated" });
    expect(svc.updateCompany).toHaveBeenCalledWith("c1", { name: "acme" });
  });

  it("sem número e nome ambíguo com atualização → erro, nenhuma empresa alterada", async () => {
    db.company.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const r = await importCompanyRow({ name: "Acme" }, ALL, true);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.message).toMatch(/Número/);
    expect(svc.updateCompany).not.toHaveBeenCalled();
  });

  it("atualização não apaga campo vazio nem coluna ausente", async () => {
    svc.findCompanyByNumber.mockResolvedValue({ id: "c7", number: 7, name: "Acme" });
    await importCompanyRow(
      { name: "Acme", number: "7", phone: "", domain: "a@b.com" },
      new Set(["number", "name", "phone", "domain"]),
      true,
    );
    expect(svc.updateCompany).toHaveBeenCalledWith("c7", { name: "Acme", domain: "a@b.com" });
  });

  it("conflito de número na criação (corrida) → erro claro na linha", async () => {
    svc.createCompany.mockRejectedValue(new CompanyNumberConflictError(1001));
    const r = await importCompanyRow({ name: "Acme", number: "1001" }, ALL, true);
    expect(r).toEqual({
      kind: "failed",
      message: "Já existe uma empresa com o número 1001 nesta organização.",
    });
  });
});
