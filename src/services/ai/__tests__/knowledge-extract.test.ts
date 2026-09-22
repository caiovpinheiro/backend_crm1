import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  extractKnowledgeText,
  KnowledgeExtractError,
  MAX_UPLOAD_BYTES,
  SUPPORTED_EXTENSIONS,
} from "@/services/ai/knowledge-extract";

vi.mock("pdf-parse", () => ({
  default: vi.fn(async () => ({ text: "Texto extraído do PDF." })),
}));

function docxBuffer(text: string): Buffer {
  const { unzipSync, zipSync, strToU8 } = require("fflate");
  // Garante que unzipSync está disponível.
  void unzipSync;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`;
  const zipped = zipSync({ "word/document.xml": strToU8(xml) });
  return Buffer.from(zipped);
}

describe("extractKnowledgeText", () => {
  it("extrai texto de .txt", async () => {
    const result = await extractKnowledgeText("faq.txt", Buffer.from("Perguntas frequentes.\n\nResposta um."));
    expect(result.mimeType).toBe("text/plain");
    expect(result.text).toContain("Perguntas frequentes");
  });

  it("extrai texto de .md", async () => {
    const result = await extractKnowledgeText("guia.md", Buffer.from("# Título\n\nConteúdo."));
    expect(result.mimeType).toBe("text/markdown");
    expect(result.text).toContain("# Título");
  });

  it("extrai texto de .csv", async () => {
    const result = await extractKnowledgeText("dados.csv", Buffer.from("nome,idade\nJoão,30\n"));
    expect(result.mimeType).toBe("text/csv");
    expect(result.text).toContain("nome,idade");
  });

  it("extrai texto de .docx", async () => {
    const result = await extractKnowledgeText("doc.docx", docxBuffer("Texto do Word."));
    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result.text).toContain("Texto do Word");
  });

  it("extrai texto de .pdf", async () => {
    const result = await extractKnowledgeText("arquivo.pdf", Buffer.from("pdf-binary-stub"));
    expect(result.mimeType).toBe("application/pdf");
    expect(result.text).toContain("Texto extraído do PDF");
  });

  it("rejeita formato não suportado com mensagem clara", async () => {
    await expect(extractKnowledgeText("foto.png", Buffer.from("xyz"))).rejects.toThrow(
      KnowledgeExtractError,
    );
    await expect(extractKnowledgeText("foto.png", Buffer.from("xyz"))).rejects.toThrow(
      /Aceitamos/,
    );
  });

  it("rejeita arquivo vazio", async () => {
    await expect(extractKnowledgeText("vazio.txt", Buffer.from(""))).rejects.toThrow(
      "Arquivo vazio",
    );
  });

  it("rejeita arquivo maior que o limite", async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    await expect(extractKnowledgeText("grande.txt", big)).rejects.toThrow(/muito grande/);
  });

  it("rejeita texto extraído muito curto", async () => {
    await expect(extractKnowledgeText("curto.txt", Buffer.from("oi"))).rejects.toThrow(
      /extrair texto útil/,
    );
  });

  it("lista PDF entre as extensões suportadas", () => {
    expect(SUPPORTED_EXTENSIONS).toContain("pdf");
  });
});
