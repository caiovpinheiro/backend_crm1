/**
 * Extração de texto dos arquivos enviados para a base de conhecimento
 * dos agentes.
 *
 * Formatos suportados:
 *  - texto puro (`.txt`, `.md`, `.markdown`, `.csv`, `.tsv`): decode utf-8;
 *  - `.docx`: o arquivo é um ZIP de XML — abrimos `word/document.xml` com
 *    `fflate` (puro JS, sem binário nativo) e concatenamos os nós `<w:t>`.
 *  - `.pdf`: extraído com `pdf-parse` (texto selecionável; PDFs escaneados
 *    ou baseados em imagem exigiriam OCR e ainda não são suportados).
 *
 * O custo de extração é O(tamanho do arquivo) em memória e sem I/O de
 * rede — com o limite de 10 MB por upload isso fica na casa de dezenas de
 * ms, então roda inline no handler. O trabalho pesado de verdade
 * (chunking + embeddings) continua em background via `scheduleIndexing`.
 */

import { unzipSync } from "fflate";

/** Limite de bytes do arquivo enviado. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Limite de caracteres do texto extraído — mesmo do POST JSON. */
export const MAX_EXTRACTED_CHARS = 500_000;

type SupportedExt = "txt" | "md" | "markdown" | "csv" | "tsv" | "docx" | "pdf";

const PLAIN_TEXT_EXTS = new Set<SupportedExt>([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
]);

const MIME_BY_EXT: Record<SupportedExt, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export const SUPPORTED_EXTENSIONS = Object.keys(MIME_BY_EXT) as SupportedExt[];

export class KnowledgeExtractError extends Error {}

function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) return "";
  return fileName.slice(idx + 1).toLowerCase();
}

/** Nome do arquivo sem extensão, usado como título default. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const idx = base.lastIndexOf(".");
  const stem = idx > 0 ? base.slice(0, idx) : base;
  return stem.trim().slice(0, 200) || "Documento";
}

/**
 * Decodifica utf-8 removendo BOM e caracteres de controle que quebram o
 * chunking (o `\0` chega a derrubar o insert no Postgres).
 */
function decodeText(buffer: Buffer): string {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/**
 * Converte o `word/document.xml` do docx em texto corrido.
 * Não tentamos reconstruir formatação: para RAG só interessa o texto,
 * com quebra de parágrafo (`</w:p>`) e de linha (`<w:br/>`) preservadas.
 */
function docxXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n\n")
    .replace(/<\/w:tc>/g, "\t");

  const parts: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|(\n|\t)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withBreaks)) != null) {
    if (match[1] != null) parts.push(decodeXmlEntities(match[1]));
    else if (match[2] != null) parts.push(match[2]);
  }
  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDocx(buffer: Buffer): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer), {
      filter: (file) => file.name === "word/document.xml",
    });
  } catch {
    throw new KnowledgeExtractError(
      "Não foi possível ler o .docx (arquivo corrompido ou protegido por senha).",
    );
  }
  const document = entries["word/document.xml"];
  if (!document) {
    throw new KnowledgeExtractError(
      "O .docx não contém texto legível (word/document.xml ausente).",
    );
  }
  return docxXmlToText(decodeText(Buffer.from(document)));
}

/**
 * O pdf.js (dentro do pdf-parse 2.x) referencia DOMMatrix, ImageData e
 * Path2D ao carregar, e só os tem no Node com o binário nativo do
 * @napi-rs/canvas. Sem ele o import quebrava ("DOMMatrix is not defined")
 * e a rota devolvia 500. Extrair texto não desenha nada: classes vazias
 * bastam, e só entram quando o ambiente não tem as de verdade.
 */
function ensurePdfGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
    if (typeof g[name] === "undefined") g[name] = class {};
  }
}

/**
 * PDF com mini-calendário ao lado de uma lista (calendário, escala, agenda):
 * a extração junta as duas colunas e a linha vira "25 26 27 28 29 30 31 19
 * Evento". O leitor tomava o 25 como a data do evento. Tira o cabeçalho de
 * dias da semana ("D S T Q Q S S") e a sequência de dias consecutivos no
 * começo da linha; sobra a linha do evento.
 */
export function stripCalendarGrid(text: string): string {
  const WEEK_HEADER = /^\s*(?:[DSTQ]\s+){6}[DSTQ](?=\s|$)\s*/;
  return text
    .split("\n")
    .map((line) => {
      let l = line.replace(WEEK_HEADER, "");
      // Linha só de números: sobra da grade, sem evento ao lado.
      if (/^\s*(?:\d{1,2}\s*)+$/.test(l)) return "";
      const m = /^\s*((?:\d{1,2}\s+){3,})/.exec(l);
      if (m) {
        const tokens = m[1].trim().split(/\s+/);
        const nums = tokens.map(Number);
        // Sequência de dias (n, n+1…) de uma semana: no máximo 7. O número
        // seguinte, mesmo consecutivo, é o dia do evento.
        let run = 1;
        while (run < nums.length && run < 7 && nums[run] === nums[run - 1] + 1 && nums[run] <= 31) run++;
        if (run >= 3) {
          // Tokens originais: "07" continua "07".
          const leftover = tokens.slice(run).join(" ");
          l = [leftover, l.slice(m[0].length)].filter(Boolean).join(" ");
        }
      }
      return l.trimEnd();
    })
    .filter((line) => line.trim() !== "")
    .join("\n");
}

async function extractPdf(buffer: Buffer): Promise<string> {
  let parser: { getText: (p?: object) => Promise<{ text?: string }>; destroy: () => Promise<void> } | undefined;
  try {
    ensurePdfGlobals();
    const { PDFParse } = (await import("pdf-parse")) as unknown as {
      PDFParse: new (opts: { data: Uint8Array }) => NonNullable<typeof parser>;
    };
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    // pageJoiner vazio: sem o marcador "-- 1 of N --" entre as páginas.
    const result = await parser.getText({ pageJoiner: "" });
    return stripCalendarGrid((result.text ?? "").replace(/\u0000/g, "").replace(/\r\n/g, "\n")).trim();
  } catch (err) {
    console.error("[knowledge] falha ao ler PDF:", err instanceof Error ? err.message : err);
    throw new KnowledgeExtractError(
      "Não foi possível extrair texto do PDF. Verifique se o arquivo não está corrompido ou é uma imagem escaneada.",
    );
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

export type ExtractedDocument = {
  text: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Valida e extrai o texto de um arquivo enviado. Lança
 * `KnowledgeExtractError` com mensagem pronta para o usuário — o handler
 * traduz em HTTP 400.
 */
export async function extractKnowledgeText(
  fileName: string,
  buffer: Buffer,
): Promise<ExtractedDocument> {
  if (buffer.byteLength === 0) {
    throw new KnowledgeExtractError("Arquivo vazio.");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new KnowledgeExtractError(
      `Arquivo muito grande (limite ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`,
    );
  }

  const ext = extensionOf(fileName);
  if (!(ext in MIME_BY_EXT)) {
    throw new KnowledgeExtractError(
      `Formato não suportado. Aceitamos ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`,
    );
  }
  const supported = ext as SupportedExt;

  let text: string;
  if (PLAIN_TEXT_EXTS.has(supported)) {
    text = decodeText(buffer).trim();
  } else if (supported === "pdf") {
    text = await extractPdf(buffer);
  } else {
    text = extractDocx(buffer);
  }

  if (text.length < 10) {
    throw new KnowledgeExtractError(
      "Não foi possível extrair texto útil do arquivo.",
    );
  }
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new KnowledgeExtractError(
      `Texto extraído muito grande (${text.length.toLocaleString("pt-BR")} caracteres; limite ${MAX_EXTRACTED_CHARS.toLocaleString("pt-BR")}). Divida o documento.`,
    );
  }

  return {
    text,
    mimeType: MIME_BY_EXT[supported],
    sizeBytes: buffer.byteLength,
  };
}
