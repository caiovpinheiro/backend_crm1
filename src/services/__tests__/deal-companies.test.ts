/**
 * Empresas do negócio: a primeira vira principal; trocar e tirar a principal
 * promovem outra; filtros "por empresa" contam qualquer posição.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = { dealCompany: { updateMany: vi.fn(), create: vi.fn() } };
  return {
    tx,
    company: { findFirst: vi.fn() },
    dealCompany: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === "function" ? (arg as (t: unknown) => unknown)(tx) : arg)),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));

const svc = await import("../deal-companies");

const company = {
  id: "c1", number: 4, name: "Cacau Lopes", size: "12.345.678/0001-90", phone: "+551130000000",
  domain: "rh@cacaulopes.com.br", cep: "01000-000", city: "São Paulo", state: "SP", address: "Rua A, 100",
};

beforeEach(() => vi.clearAllMocks());

describe("linkDealCompany", () => {
  it("primeira empresa do negócio vira principal", async () => {
    db.company.findFirst.mockResolvedValue({ id: "c1", name: "Cacau Lopes" });
    db.dealCompany.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await svc.linkDealCompany("d1", "c1")).toEqual({ companyName: "Cacau Lopes", isPrimary: true });
    expect(db.tx.dealCompany.create).toHaveBeenCalledWith({
      data: { dealId: "d1", companyId: "c1", isPrimary: true },
      select: { id: true },
    });
    expect(db.tx.dealCompany.updateMany).not.toHaveBeenCalled();
  });

  it("já tem principal: entra como secundária", async () => {
    db.company.findFirst.mockResolvedValue({ id: "c2", name: "iad" });
    db.dealCompany.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "x" });
    expect(await svc.linkDealCompany("d1", "c2")).toEqual({ companyName: "iad", isPrimary: false });
  });

  it("pedindo principal: tira a anterior", async () => {
    db.company.findFirst.mockResolvedValue({ id: "c2", name: "iad" });
    db.dealCompany.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "x" });
    await svc.linkDealCompany("d1", "c2", { primary: true });
    expect(db.tx.dealCompany.updateMany).toHaveBeenCalledWith({
      where: { dealId: "d1", isPrimary: true },
      data: { isPrimary: false },
    });
  });

  it("empresa inexistente ou já vinculada: erro sem gravar", async () => {
    db.company.findFirst.mockResolvedValue(null);
    await expect(svc.linkDealCompany("d1", "x")).rejects.toMatchObject({ code: "EMPRESA_INEXISTENTE" });
    db.company.findFirst.mockResolvedValue({ id: "c1", name: "A" });
    db.dealCompany.findFirst.mockResolvedValueOnce({ id: "dup" });
    await expect(svc.linkDealCompany("d1", "c1")).rejects.toMatchObject({ code: "EMPRESA_JA_VINCULADA" });
    expect(db.tx.dealCompany.create).not.toHaveBeenCalled();
  });
});

describe("unlink / principal", () => {
  it("tirar a principal promove a mais antiga que sobrou", async () => {
    db.dealCompany.findFirst
      .mockResolvedValueOnce({ id: "l1", isPrimary: true, company: { name: "Cacau" } })
      .mockResolvedValueOnce({ id: "l2" });
    await svc.unlinkDealCompany("d1", "c1");
    expect(db.dealCompany.delete).toHaveBeenCalledWith({ where: { id: "l1" }, select: { id: true } });
    expect(db.dealCompany.update).toHaveBeenCalledWith({ where: { id: "l2" }, data: { isPrimary: true }, select: { id: true } });
  });

  it("tirar uma secundária não mexe na principal", async () => {
    db.dealCompany.findFirst.mockResolvedValueOnce({ id: "l3", isPrimary: false, company: { name: "iad" } });
    await svc.unlinkDealCompany("d1", "c3");
    expect(db.dealCompany.update).not.toHaveBeenCalled();
  });

  it("vínculo inexistente: erro", async () => {
    db.dealCompany.findFirst.mockResolvedValue(null);
    await expect(svc.setPrimaryDealCompany("d1", "c9")).rejects.toMatchObject({ code: "VINCULO_INEXISTENTE" });
    await expect(svc.unlinkDealCompany("d1", "c9")).rejects.toMatchObject({ code: "VINCULO_INEXISTENTE" });
  });
});

describe("leitura", () => {
  it("lista com os dados da empresa (CNPJ e e-mail com nome certo)", async () => {
    db.dealCompany.findMany.mockResolvedValue([
      { companyId: "c1", isPrimary: true, createdAt: new Date("2026-11-16T12:00:00Z"), company },
    ]);
    const [item] = await svc.listDealCompanies("d1");
    expect(item.company).toMatchObject({ cnpj: "12.345.678/0001-90", email: "rh@cacaulopes.com.br", city: "São Paulo" });
    expect(db.dealCompany.findMany.mock.calls[0][0].orderBy).toEqual([{ isPrimary: "desc" }, { createdAt: "asc" }]);
  });

  it("negócios da empresa em qualquer posição", async () => {
    db.dealCompany.findMany.mockResolvedValue([{ dealId: "d1" }, { dealId: "d2" }]);
    expect(await svc.dealIdsForCompany("c1")).toEqual(["d1", "d2"]);
    expect(db.dealCompany.findMany).toHaveBeenCalledWith({ where: { companyId: "c1" }, select: { dealId: true } });
  });

  it("variáveis {{empresa.*}} da principal; sem empresa ficam vazias", () => {
    const vars = svc.companyMessageVars({
      id: "c1", number: 4, name: "Cacau Lopes", cnpj: "12.345.678/0001-90", phone: null, email: null,
      cep: "01000-000", city: "São Paulo", state: "SP", address: "Rua A, 100",
    });
    expect(vars.empresa).toMatchObject({ nome: "Cacau Lopes", cidade: "São Paulo", endereco: "Rua A, 100", telefone: "" });
    expect(vars.company.name).toBe("Cacau Lopes");
    expect(svc.companyMessageVars(null).empresa.nome).toBe("");
  });
});
