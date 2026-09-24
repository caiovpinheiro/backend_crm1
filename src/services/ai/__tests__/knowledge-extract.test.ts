import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  extractKnowledgeText,
  KnowledgeExtractError,
  MAX_UPLOAD_BYTES,
  SUPPORTED_EXTENSIONS,
} from "@/services/ai/knowledge-extract";

// PDF real de 2 páginas (a biblioteca de verdade, sem mock: o mock antigo
// imitava a API da versão 1 e escondia que a 2.x quebrava ao carregar).
function pdfBuffer(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  objs.push(`<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`);
    objs.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  });
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  const body = objs.map((o, i) => `${i + 1} 0 obj${o}endobj`).join("\n");
  return Buffer.from(`%PDF-1.4\n${body}\ntrailer<</Root 1 0 R>>\n%%EOF`);
}

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

  it("extrai texto de .pdf de várias páginas, sem marcador de página", async () => {
    const result = await extractKnowledgeText("calendario.pdf", pdfBuffer(["Calendario 2026", "Segundo semestre"]));
    expect(result.mimeType).toBe("application/pdf");
    expect(result.text).toContain("Calendario 2026");
    expect(result.text).toContain("Segundo semestre");
    expect(result.text).not.toMatch(/-- \d+ of \d+ --/);
  }, 30_000);

  it("PDF corrompido vira mensagem clara, não erro do servidor", async () => {
    await expect(extractKnowledgeText("ruim.pdf", Buffer.from("isto não é um pdf"))).rejects.toThrow(KnowledgeExtractError);
  }, 30_000);

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

describe("stripCalendarGrid", () => {
  it("tira a grade do mês grudada na linha do evento", async () => {
    const { stripCalendarGrid } = await import("@/services/ai/knowledge-extract");
    const text = [
      "DIA/PERÍODO ATIVIDADE",
      "D S T Q Q S S 01 Início das aulas do mês",
      "1 2 3 02 a 05 Realização da prova",
      "4 5 6 7 8 9 10 06 Solicitação de recursos",
      "11 12 13 14 15 16 17 18 Evento no dia seguinte da grade",
      "25 26 27 28 29 30 31 19 Liberação de notas",
      "30 31",
      "21 Evento sem grade",
    ].join("\n");
    expect(stripCalendarGrid(text)).toBe(
      [
        "DIA/PERÍODO ATIVIDADE",
        "01 Início das aulas do mês",
        "02 a 05 Realização da prova",
        "06 Solicitação de recursos",
        "18 Evento no dia seguinte da grade",
        "19 Liberação de notas",
        "21 Evento sem grade",
      ].join("\n"),
    );
  });

  it("não mexe em lista numerada nem em texto comum", async () => {
    const { stripCalendarGrid } = await import("@/services/ai/knowledge-extract");
    const t = "1. Acesse o portal\n2. Clique em Documentos\nO prazo é de 10 dias.";
    expect(stripCalendarGrid(t)).toBe(t);
  });
});
