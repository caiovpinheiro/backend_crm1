/**
 * SEC2-3 — `sniffAttachment` decide pelo conteúdo, não pelo nome/Content-Type.
 */
import { describe, expect, it } from "vitest";

import { sniffAttachment } from "./file-sniff";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0x01),
]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0x00)]);
const HTML = Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function zipWith(firstEntryName: string, firstEntryBody = ""): Buffer {
  // Local file header mínimo: PK\x03\x04 + 26 bytes de campos + nome + corpo.
  const header = Buffer.alloc(30, 0);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(firstEntryName.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([
    header,
    Buffer.from(firstEntryName, "latin1"),
    Buffer.from(firstEntryBody, "latin1"),
    Buffer.alloc(64, 0),
  ]);
}

describe("sniffAttachment", () => {
  it("aceita PNG mesmo com nome .exe e Content-Type errado", () => {
    const r = sniffAttachment(PNG, { mime: "application/x-msdownload", fileName: "foto.exe" });
    expect(r).toEqual({ mime: "image/png", ext: "png" });
  });

  it("recusa HTML renomeado para .png (extensão falsa)", () => {
    expect(sniffAttachment(HTML, { mime: "image/png", fileName: "foto.png" })).toBeNull();
  });

  it("recusa SVG (vetor XSS) mesmo declarado como imagem", () => {
    expect(sniffAttachment(SVG, { mime: "image/svg+xml", fileName: "logo.svg" })).toBeNull();
  });

  it("recusa executável enviado como application/octet-stream", () => {
    expect(
      sniffAttachment(EXE, { mime: "application/octet-stream", fileName: "setup.pdf" }),
    ).toBeNull();
  });

  it("PDF declarado como octet-stream é aceito pelo conteúdo", () => {
    expect(sniffAttachment(PDF, { mime: "application/octet-stream", fileName: "x.bin" })).toEqual({
      mime: "application/pdf",
      ext: "pdf",
    });
  });

  it("ZIP OOXML: extensão declarada desempata docx/xlsx; sem hint vira zip", () => {
    const ooxml = zipWith("[Content_Types].xml", "<Types/>");
    expect(sniffAttachment(ooxml, { fileName: "planilha.xlsx" })?.ext).toBe("xlsx");
    expect(sniffAttachment(ooxml, { fileName: "doc.docx" })?.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(sniffAttachment(ooxml, { fileName: "coisa.exe" })).toEqual({
      mime: "application/zip",
      ext: "zip",
    });
  });

  it("ZIP comum é zip, nunca o tipo declarado", () => {
    const plain = zipWith("readme.txt", "hello");
    expect(sniffAttachment(plain, { mime: "image/png", fileName: "a.png" })).toEqual({
      mime: "application/zip",
      ext: "zip",
    });
  });

  it("ODF: lê o MIME da entrada `mimetype`", () => {
    const ods = zipWith("mimetype", "application/vnd.oasis.opendocument.spreadsheet");
    expect(sniffAttachment(ods, {})).toEqual({
      mime: "application/vnd.oasis.opendocument.spreadsheet",
      ext: "ods",
    });
  });

  it("texto simples: csv só quando declarado; extensão vem do MIME detectado", () => {
    const csv = Buffer.from("nome,email\nJoão,j@x.com\n");
    expect(sniffAttachment(csv, { fileName: "lista.csv" })).toEqual({ mime: "text/csv", ext: "csv" });
    expect(sniffAttachment(csv, { fileName: "lista.exe", mime: "application/octet-stream" })).toEqual({
      mime: "text/plain",
      ext: "txt",
    });
  });

  it("mp4: hint de áudio vira m4a; padrão é vídeo", () => {
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftypisom"),
      Buffer.alloc(16, 0),
    ]);
    expect(sniffAttachment(mp4, { mime: "audio/mp4" })).toEqual({ mime: "audio/mp4", ext: "m4a" });
    expect(sniffAttachment(mp4, { mime: "video/mp4" })).toEqual({ mime: "video/mp4", ext: "mp4" });
  });

  it("buffer vazio/curto é null", () => {
    expect(sniffAttachment(Buffer.alloc(0), {})).toBeNull();
    expect(sniffAttachment(Buffer.from("ab"), {})).toBeNull();
  });
});
