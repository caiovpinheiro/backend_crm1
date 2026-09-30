/**
 * SEC2-4 — assinatura real + teto de linhas antes do parse.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  ImportFileError,
  assertImportFileSignature,
  countCsvLines,
  importKindFromName,
  inspectZipDirectory,
} from "./import-file-guard";
import { readTableFromBuffer } from "./import-helpers";

async function buildXlsx(rows: string[][]): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Plan1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("importKindFromName", () => {
  it("mapeia extensões conhecidas", () => {
    expect(importKindFromName("a.XLSX")).toBe("xlsx");
    expect(importKindFromName("a.xls")).toBe("xls");
    expect(importKindFromName("a.ods")).toBe("ods");
    expect(importKindFromName("a.csv")).toBe("csv");
    expect(importKindFromName("a.html")).toBeNull();
  });
});

describe("assertImportFileSignature", () => {
  it("recusa HTML renomeado para .xlsx (sem PK\\x03\\x04)", () => {
    const html = Buffer.from("<html><table><tr><td>a</td></tr></table></html>");
    expect(() => assertImportFileSignature(html, "xlsx")).toThrow(ImportFileError);
    try {
      assertImportFileSignature(html, "xlsx");
    } catch (e) {
      expect((e as ImportFileError).status).toBe(415);
    }
  });

  it("recusa HTML renomeado para .xls (nem OLE2 nem ZIP)", () => {
    const html = Buffer.from("<html><table></table></html>");
    expect(() => assertImportFileSignature(html, "xls")).toThrow(ImportFileError);
  });

  it("aceita xlsx real e lê o diretório central", async () => {
    const buf = await buildXlsx([["nome", "email"], ["Ana", "a@x.com"]]);
    expect(() => assertImportFileSignature(buf, "xlsx")).not.toThrow();
    const zip = inspectZipDirectory(buf);
    expect(zip).not.toBeNull();
    expect(zip!.entries).toBeGreaterThan(3);
    expect(zip!.totalUncompressed).toBeGreaterThan(0);
  });

  it("recusa ZIP truncado (sem EOCD)", () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 0)]);
    expect(() => assertImportFileSignature(fake, "xlsx")).toThrow(/corrompida|truncada/);
  });

  it("recusa CSV binário (NUL)", () => {
    const bin = Buffer.from([0x61, 0x2c, 0x00, 0x62]);
    expect(() => assertImportFileSignature(bin, "csv")).toThrow(ImportFileError);
  });
});

describe("countCsvLines", () => {
  it("para cedo ao passar do máximo", () => {
    const buf = Buffer.from("a\nb\nc\nd\ne\n");
    expect(countCsvLines(buf, 2)).toBe(3);
    expect(countCsvLines(buf, 100)).toBe(5);
  });
});

describe("readTableFromBuffer com limites", () => {
  it("CSV acima do teto de linhas → ImportFileError 413", async () => {
    const csv = Buffer.from("nome,email\n" + "a,b\n".repeat(5));
    await expect(readTableFromBuffer(csv, "x.csv", ",", { maxRows: 3 })).rejects.toMatchObject({
      name: "ImportFileError",
      status: 413,
    });
  });

  it("CSV dentro do teto é lido normalmente", async () => {
    const csv = Buffer.from("nome,email\n" + "a,b\n".repeat(3));
    const r = await readTableFromBuffer(csv, "x.csv", ",", { maxRows: 3 });
    expect(r.rows).toHaveLength(3);
  });

  it("XLSX acima do teto de linhas → 413 (via sheetRows)", async () => {
    const buf = await buildXlsx([["nome"], ["a"], ["b"], ["c"], ["d"]]);
    await expect(readTableFromBuffer(buf, "x.xlsx", undefined, { maxRows: 2 })).rejects.toMatchObject({
      status: 413,
    });
  });

  it("XLSX dentro do teto é lido", async () => {
    const buf = await buildXlsx([["nome", "email"], ["Ana", "a@x.com"], ["Bia", "b@x.com"]]);
    const r = await readTableFromBuffer(buf, "x.xlsx", undefined, { maxRows: 10 });
    expect(r.headers).toEqual(["nome", "email"]);
    expect(r.rows).toHaveLength(2);
  });

  it("HTML com nome .xlsx é recusado antes do SheetJS", async () => {
    const html = Buffer.from("<html><table><tr><td>a</td></tr></table></html>");
    await expect(readTableFromBuffer(html, "x.xlsx")).rejects.toMatchObject({ status: 415 });
  });
});
