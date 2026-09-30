/**
 * SEC2-4 — POST /api/contacts/import recusa arquivo acima do teto de bytes
 * e planilha com assinatura falsa, antes de tocar no storage/fila.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveFile, enqueueImportEtl, bulkCreate } = vi.hoisted(() => ({
  saveFile: vi.fn(),
  enqueueImportEtl: vi.fn(),
  bulkCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => ({
    user: { id: "u1", organizationId: "org1", role: "ADMIN", isSuperAdmin: false, name: "Admin" },
  }),
}));
vi.mock("@/lib/import-guard", () => ({
  assertImportPermission: () => null,
  assertNoActiveImport: async () => null,
}));
// O core de import puxa o pool dedicado do Prisma (`prisma-import`) no load;
// aqui só interessa o gate de tamanho/assinatura da rota.
vi.mock("@/lib/contact-import-core", () => ({
  validateContactImportHeaders: () => null,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { bulkOperation: { create: bulkCreate, update: vi.fn() } },
}));
vi.mock("@/lib/queue", () => ({
  IMPORT_ETL_JOB_NAMES: { contactImport: "contact-import" },
  enqueueImportEtl,
}));
vi.mock("@/lib/storage/local", () => ({
  generateFileName: ({ prefix, ext }: { prefix: string; ext: string }) => `${prefix}-1.${ext}`,
  saveFile,
}));

import { IMPORT_MAX_BYTES } from "@/lib/import-file-guard";
import { POST } from "./route";

function req(file: File): Request {
  const fd = new FormData();
  fd.set("file", file);
  return new Request("http://localhost/api/contacts/import", { method: "POST", body: fd });
}

describe("POST /api/contacts/import — limites (SEC2-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveFile.mockResolvedValue({ url: "/api/storage/org1/imports/contacts-1.csv" });
    bulkCreate.mockResolvedValue({ id: "op1" });
    enqueueImportEtl.mockResolvedValue({ id: "job1" });
  });

  it("413 quando o arquivo passa do teto de bytes", async () => {
    const big = new File([new Uint8Array(IMPORT_MAX_BYTES + 1)], "grande.csv", {
      type: "text/csv",
    });
    const res = await POST(req(big));
    expect(res.status).toBe(413);
    expect(saveFile).not.toHaveBeenCalled();
    expect(enqueueImportEtl).not.toHaveBeenCalled();
  });

  it("415 quando .xlsx não tem assinatura ZIP (HTML renomeado)", async () => {
    const html = new File(["<html><table><tr><td>nome</td></tr></table></html>"], "lista.xlsx");
    const res = await POST(req(html));
    expect(res.status).toBe(415);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("CSV pequeno e válido segue para a fila (202)", async () => {
    const csv = new File(["nome,email,telefone\nAna,ana@x.com,11999999999\n"], "ok.csv", {
      type: "text/csv",
    });
    const res = await POST(req(csv));
    expect(res.status).toBe(202);
    expect(saveFile).toHaveBeenCalledTimes(1);
  });
});
