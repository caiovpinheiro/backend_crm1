/**
 * Extração de texto dos arquivos enviados para a base de conhecimento
 * dos agentes.
 *
 * Formatos suportados:
 *  - texto puro (`.txt`, `.md`, `.markdown`, `.csv`, `.tsv`): decode utf-8;
 *  - `.docx`: o arquivo é um ZIP de XML — abrimos `word/document.xml` com
 *    `fflate` (puro JS, sem binário nativo) e concatenamos os nós `<w:t>`.
 *
 * `.pdf` NÃO é suportado: as libs de extração (pdfjs-dist e derivados)
 * pesam dezenas de MB no bundle e ainda assim não resolvem PDF escaneado,
 * que exigiria OCR. Rejeitamos com mensagem explícita em vez de indexar
 * lixo binário.
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

type SupportedExt = "txt" | "md" | "markdown" | "csv" | "tsv" | "docx";

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
export function extractKnowledgeText(
  fileName: string,
  buffer: Buffer,
): ExtractedDocument {
  if (buffer.byteLength === 0) {
    throw new KnowledgeExtractError("Arquivo vazio.");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new KnowledgeExtractError(
      `Arquivo muito grande (limite ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`,
    );
  }

  const ext = extensionOf(fileName);
  if (ext === "pdf") {
    throw new KnowledgeExtractError(
      "PDF ainda não é suportado. Converta para .docx, .md ou .txt e envie novamente.",
    );
  }
  if (!(ext in MIME_BY_EXT)) {
    throw new KnowledgeExtractError(
      `Formato não suportado. Aceitamos ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`,
    );
  }
  const supported = ext as SupportedExt;

  const text = PLAIN_TEXT_EXTS.has(supported)
    ? decodeText(buffer).trim()
    : extractDocx(buffer);

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
