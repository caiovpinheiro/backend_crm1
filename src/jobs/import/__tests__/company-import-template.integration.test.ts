/**
 * Integração: o CSV que o painel de importação envia a partir do MODELO de
 * empresas (XLSX ou CSV `;`, já remapeado para as chaves canônicas) passa
 * pelo worker real até o banco. Só roda com Postgres local (ver
 * `src/lib/tenant-isolation.integration.test.ts`).
 */
import { randomBytes } from "node:crypto";

import type { Job } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  hostnameFromConnectionUrl,
  isDigitalOceanManagedHost,
} from "@/lib/warn-public-do-managed-hosts";

const stored = vi.hoisted(() => ({ buffer: Buffer.from("") }));
vi.mock("@/lib/storage/local", () => ({
  readStoredFile: async () => ({ buffer: stored.buffer }),
}));

function isSafeLocalPostgres(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  const host = hostnameFromConnectionUrl(url);
  if (!host || isDigitalOceanManagedHost(host)) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const LOCAL = isSafeLocalPostgres(process.env.DATABASE_URL);
const suffix = randomBytes(4).toString("hex");

/** Exatamente o que o frontend envia a partir do modelo (`buildRemappedCsv`). */
const FROM_TEMPLATE = [
  "number,name,domain,phone,size,industry,cep,city,state,address,notes",
  ',Acme Tecnologia,contato@acme.com.br,(11) 3333-0001,00.000.000/0001-00,Tecnologia,01310-100,São Paulo,SP,"Av. Paulista, 1000",',
  ',Beta Solutions,contato@beta.com.br,(21) 3333-0002,11.111.111/0001-11,Serviços,20040-020,Rio de Janeiro,RJ,"Rua da Assembleia, 10",',
  ',Gamma Group,contato@gamma.com.br,(31) 3333-0003,22.222.222/0001-22,Indústria,30130-010,Belo Horizonte,MG,"Av. Afonso Pena, 500",Exemplo de observação',
  "2500,Delta Manual,,,,,,,,,",
].join("\n");

describe.skipIf(!LOCAL)("import de empresas a partir do modelo (Postgres local)", () => {
  let orgId = "";

  afterAll(async () => {
    if (!orgId) return;
    const { prismaBase } = await import("@/lib/prisma-base");
    await prismaBase.bulkOperation.deleteMany({ where: { organizationId: orgId } });
    await prismaBase.company.deleteMany({ where: { organizationId: orgId } });
    await prismaBase.orgNumberCounter.deleteMany({ where: { organizationId: orgId } });
    await prismaBase.organization.delete({ where: { id: orgId } });
  });

  async function runImport(updateExisting: boolean) {
    const { prismaBase } = await import("@/lib/prisma-base");
    const { withSystemContext } = await import("@/lib/webhook-context");
    const { processCompanyImport } = await import("@/jobs/import/company-import.job");
    stored.buffer = Buffer.from(FROM_TEMPLATE, "utf8");
    const op = await prismaBase.bulkOperation.create({
      data: {
        organizationId: orgId,
        type: "COMPANY_IMPORT",
        status: "PENDING",
        total: 4,
        payload: { fileName: "x.csv", originalName: "import.csv", updateExisting },
      } as never,
      select: { id: true },
    });
    const payload = {
      operationId: op.id,
      organizationId: orgId,
      initiatedByUserId: "u",
      fileName: "x.csv",
      originalName: "import.csv",
      delimiter: ",",
      updateExisting,
    };
    await withSystemContext(orgId, () =>
      processCompanyImport(payload as never, { id: "j", attemptsMade: 0, data: payload } as unknown as Job<never>),
    );
    return prismaBase.bulkOperation.findUniqueOrThrow({ where: { id: op.id } });
  }

  it("primeira carga cria todas; reimportar sem 'atualizar' ignora todas", async () => {
    const { prismaBase } = await import("@/lib/prisma-base");
    orgId = (
      await prismaBase.organization.create({
        data: { name: `Template ${suffix}`, slug: `tpl-${suffix}` },
        select: { id: true },
      })
    ).id;

    const first = await runImport(false);
    expect(first.status).toBe("COMPLETED");
    expect(first.failed).toBe(0);
    expect((first.payload as { summary: unknown }).summary).toEqual({ created: 4, updated: 0, skipped: 0 });

    const rows = await prismaBase.company.findMany({
      where: { organizationId: orgId },
      orderBy: { number: "asc" },
    });
    expect(rows.map((r) => [r.number, r.name])).toEqual([
      [1, "Acme Tecnologia"],
      [2, "Beta Solutions"],
      [3, "Gamma Group"],
      [2500, "Delta Manual"],
    ]);
    const acme = rows[0]!;
    expect(acme.phone).toBe("(11) 3333-0001");
    expect(acme.cep).toBe("01310-100");
    expect(acme.size).toBe("00.000.000/0001-00");
    expect(acme.address).toBe("Av. Paulista, 1000");

    const again = await runImport(false);
    expect(again.status).toBe("COMPLETED");
    expect((again.payload as { summary: unknown }).summary).toEqual({ created: 0, updated: 0, skipped: 4 });
    expect(await prismaBase.company.count({ where: { organizationId: orgId } })).toBe(4);
  });
});
