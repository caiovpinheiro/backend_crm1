import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  company: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: <T>(d: T) => d }));

import {
  CompanyNumberConflictError,
  createCompany,
  parseCompanyNumberInput,
} from "../companies";

describe("parseCompanyNumberInput", () => {
  it("vazio/null/undefined → gerar automaticamente", () => {
    expect(parseCompanyNumberInput(undefined)).toEqual({ ok: true, value: null });
    expect(parseCompanyNumberInput(null)).toEqual({ ok: true, value: null });
    expect(parseCompanyNumberInput("  ")).toEqual({ ok: true, value: null });
  });

  it("aceita inteiro positivo como number, string ou #N", () => {
    expect(parseCompanyNumberInput(12)).toEqual({ ok: true, value: 12 });
    expect(parseCompanyNumberInput(" 1001 ")).toEqual({ ok: true, value: 1001 });
    expect(parseCompanyNumberInput("#7")).toEqual({ ok: true, value: 7 });
    expect(parseCompanyNumberInput(2_147_483_647)).toEqual({ ok: true, value: 2_147_483_647 });
  });

  it("recusa zero, negativo, decimal, texto e acima do Int", () => {
    for (const bad of [0, -3, 1.5, "1.5", "12a", "-1", "0", true, {}, 2_147_483_648, "99999999999"]) {
      expect(parseCompanyNumberInput(bad).ok, String(bad)).toBe(false);
    }
  });
});

describe("createCompany — número manual", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.company.create.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));
  });

  it("sem número: não envia number (o contador da org gera)", async () => {
    await createCompany({ name: "Acme" });
    expect(db.company.findFirst).not.toHaveBeenCalled();
    expect(db.company.create.mock.calls[0]![0].data).not.toHaveProperty("number");
  });

  it("número livre: grava exatamente o número informado", async () => {
    db.company.findFirst.mockResolvedValue(null);
    const c = await createCompany({ name: "Acme", number: 1001 });
    expect(db.company.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { number: 1001 } }),
    );
    expect(db.company.create.mock.calls[0]![0].data.number).toBe(1001);
    expect(c.number).toBe(1001);
  });

  it("número já usado na org: CompanyNumberConflictError (409), sem criar", async () => {
    db.company.findFirst.mockResolvedValue({ id: "outra", number: 5, name: "Beta" });
    await expect(createCompany({ name: "Acme", number: 5 })).rejects.toBeInstanceOf(
      CompanyNumberConflictError,
    );
    expect(db.company.create).not.toHaveBeenCalled();
  });

  it("corrida (P2002 em number no insert): vira conflito, não troca o número", async () => {
    db.company.findFirst.mockResolvedValue(null);
    db.company.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint"), {
        code: "P2002",
        meta: { target: ["organizationId", "number"] },
      }),
    );
    const err = await createCompany({ name: "Acme", number: 9 }).catch((e) => e);
    expect(err).toBeInstanceOf(CompanyNumberConflictError);
    expect((err as CompanyNumberConflictError).status).toBe(409);
    expect(db.company.create).toHaveBeenCalledTimes(1);
  });

  it("P2002 sem número manual não é mascarado como conflito de número", async () => {
    db.company.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint"), { code: "P2002", meta: { target: ["number"] } }),
    );
    await expect(createCompany({ name: "Acme" })).rejects.not.toBeInstanceOf(
      CompanyNumberConflictError,
    );
  });
});
