/**
 * Integração Postgres do número (ID público) de empresas: geração automática
 * × número manual, concorrência, createMany misto, importação e isolamento
 * por organização.
 *
 * Só corre contra Postgres **local** (localhost / 127.0.0.1) — mesmo critério
 * de `src/lib/tenant-isolation.integration.test.ts`. Sem isso → skip.
 * Imports do Prisma são dinâmicos para o arquivo carregar sem banco.
 */
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  hostnameFromConnectionUrl,
  isDigitalOceanManagedHost,
} from "@/lib/warn-public-do-managed-hosts";

function isSafeLocalPostgres(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  const host = hostnameFromConnectionUrl(url);
  if (!host || isDigitalOceanManagedHost(host)) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const LOCAL = isSafeLocalPostgres(process.env.DATABASE_URL);
const suffix = randomBytes(4).toString("hex");

describe.skipIf(!LOCAL)("Company.number (Postgres local)", () => {
  const orgIds: string[] = [];

  async function newOrg(tag: string): Promise<string> {
    const { prismaBase } = await import("@/lib/prisma-base");
    const org = await prismaBase.organization.create({
      data: { name: `Company Number ${tag} ${suffix}`, slug: `cn-${tag}-${suffix}` },
      select: { id: true },
    });
    orgIds.push(org.id);
    return org.id;
  }

  async function inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    const { withSystemContext } = await import("@/lib/webhook-context");
    return withSystemContext(orgId, fn);
  }

  afterAll(async () => {
    if (orgIds.length === 0) return;
    const { prismaBase } = await import("@/lib/prisma-base");
    await prismaBase.company.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prismaBase.orgNumberCounter.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prismaBase.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  it("concorrência: automáticos nunca colidem com manuais e manual nunca é trocado", async () => {
    const orgId = await newOrg("race");
    const { createCompany, CompanyNumberConflictError } = await import("@/services/companies");

    // Manuais miram exatamente a faixa que o contador automático vai emitir
    // (1..30) e repetem números entre si → força as duas colisões.
    const manualTargets = Array.from({ length: 30 }, (_, i) => (i % 15) + 1);
    const jobs = [
      ...manualTargets.map((n, i) => ({ kind: "manual" as const, n, name: `M${i}` })),
      ...Array.from({ length: 30 }, (_, i) => ({ kind: "auto" as const, n: null, name: `A${i}` })),
    ].sort(() => Math.random() - 0.5);

    const results = await inOrg(orgId, () =>
      Promise.all(
        jobs.map(async (j) => {
          try {
            const c = await createCompany({ name: j.name, number: j.n });
            return { j, ok: true as const, number: c.number };
          } catch (err) {
            return { j, ok: false as const, err };
          }
        }),
      ),
    );

    // Automáticos: todos criados.
    const autos = results.filter((r) => r.j.kind === "auto");
    expect(autos.every((r) => r.ok)).toBe(true);

    // Manuais: criado com o número EXATO pedido, ou 409 — nunca outro número.
    for (const r of results.filter((x) => x.j.kind === "manual")) {
      if (r.ok) expect(r.number).toBe(r.j.n);
      else expect(r.err).toBeInstanceOf(CompanyNumberConflictError);
    }
    // Cada número manual repetido só pode ter vencido uma vez.
    const manualOk = results.filter((r) => r.j.kind === "manual" && r.ok);
    expect(new Set(manualOk.map((r) => r.ok && r.number)).size).toBe(manualOk.length);

    const { prismaBase } = await import("@/lib/prisma-base");
    const rows = await prismaBase.company.findMany({
      where: { organizationId: orgId },
      select: { number: true },
    });
    expect(rows.length).toBe(autos.length + manualOk.length);
    expect(new Set(rows.map((r) => r.number)).size).toBe(rows.length);
    expect(rows.every((r) => r.number >= 1)).toBe(true);
  }, 60_000);

  it("após número manual alto, o próximo automático vem depois dele", async () => {
    const orgId = await newOrg("after");
    const { createCompany } = await import("@/services/companies");
    await inOrg(orgId, async () => {
      const a = await createCompany({ name: "Auto 1" });
      expect(a.number).toBe(1);
      const m = await createCompany({ name: "Manual", number: 500 });
      expect(m.number).toBe(500);
      const b = await createCompany({ name: "Auto 2" });
      expect(b.number).toBe(501);
      // Manual abaixo do contador, em buraco livre: aceito como está.
      const gap = await createCompany({ name: "Gap", number: 42 });
      expect(gap.number).toBe(42);
      const c = await createCompany({ name: "Auto 3" });
      expect(c.number).toBe(502);
    });
  });

  it("createMany misto: faixa automática pula os manuais do próprio lote", async () => {
    const orgId = await newOrg("many");
    const { prisma } = await import("@/lib/prisma");
    await inOrg(orgId, async () => {
      await prisma.company.createMany({
        data: [
          { organizationId: orgId, name: "X1" },
          { organizationId: orgId, name: "Manual 3", number: 3 },
          { organizationId: orgId, name: "X2" },
          { organizationId: orgId, name: "X3" },
        ],
      });
      const rows = await prisma.company.findMany({
        select: { name: true, number: true },
        orderBy: { number: "asc" },
      });
      expect(rows.find((r) => r.name === "Manual 3")?.number).toBe(3);
      const autos = rows.filter((r) => r.name.startsWith("X")).map((r) => r.number);
      expect(autos.every((n) => n > 3)).toBe(true);
      expect(new Set(rows.map((r) => r.number)).size).toBe(rows.length);
    });
  });

  it("isolamento: o mesmo número manual vale em outra organização", async () => {
    const orgA = await newOrg("iso-a");
    const orgB = await newOrg("iso-b");
    const { createCompany, CompanyNumberConflictError, findCompanyByNumber } = await import(
      "@/services/companies"
    );
    await inOrg(orgA, () => createCompany({ name: "A", number: 77 }));
    const b = await inOrg(orgB, () => createCompany({ name: "B", number: 77 }));
    expect(b.number).toBe(77);
    await expect(inOrg(orgA, () => createCompany({ name: "A2", number: 77 }))).rejects.toBeInstanceOf(
      CompanyNumberConflictError,
    );
    const seenFromB = await inOrg(orgB, () => findCompanyByNumber(77));
    expect(seenFromB?.name).toBe("B");
  });

  it("importação: número tem prioridade sobre nome e ambíguo não é atualizado", async () => {
    const orgId = await newOrg("import");
    const { createCompany } = await import("@/services/companies");
    const { importCompanyRow } = await import("@/jobs/import/company-import.job");
    const { prisma } = await import("@/lib/prisma");
    const fields = new Set(["number", "name", "city"]);

    await inOrg(orgId, async () => {
      const acme1 = await createCompany({ name: "Acme", number: 10, city: "SP" });
      await createCompany({ name: "Acme", number: 11, city: "RJ" });
      await createCompany({ name: "Beta", number: 12 });

      // Sem "atualizar": existente (por número) é ignorado.
      expect(await importCompanyRow({ number: "10", name: "Acme", city: "BH" }, fields, false)).toEqual({
        kind: "skipped",
      });
      // Por número: atualiza a #10 (não a #11, de mesmo nome).
      expect(await importCompanyRow({ number: "10", name: "Acme", city: "BH" }, fields, true)).toEqual({
        kind: "updated",
      });
      // Sem número e nome ambíguo: erro, nada muda.
      const amb = await importCompanyRow({ name: "acme", city: "POA" }, fields, true);
      expect(amb.kind).toBe("failed");
      // Sem número e nome único: atualiza.
      expect(await importCompanyRow({ name: "beta", city: "CWB" }, fields, true)).toEqual({
        kind: "updated",
      });
      // Número novo: cria com ele.
      expect(await importCompanyRow({ number: "900", name: "Gamma" }, fields, true)).toEqual({
        kind: "created",
      });
      // Duas linhas com o mesmo número novo: a segunda já encontra a primeira.
      expect(await importCompanyRow({ number: "901", name: "Delta" }, fields, false)).toEqual({
        kind: "created",
      });
      expect(await importCompanyRow({ number: "901", name: "Delta 2" }, fields, false)).toEqual({
        kind: "skipped",
      });

      const all = await prisma.company.findMany({
        select: { id: true, number: true, name: true, city: true },
        orderBy: { number: "asc" },
      });
      expect(all.find((c) => c.id === acme1.id)?.city).toBe("BH");
      expect(all.find((c) => c.number === 11)?.city).toBe("RJ");
      expect(all.find((c) => c.number === 12)?.city).toBe("CWB");
      expect(all.find((c) => c.number === 900)?.name).toBe("Gamma");
      expect(all.filter((c) => c.number === 901)).toHaveLength(1);
    });
  });
});
