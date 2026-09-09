/**
 * Extração de texto dos arquivos enviados para a base de conhecimento
 * dos agentes.
 *
 * Formatos suportados:
 *  - texto puro (`.txt`, `.md`, `.markdown`, `.csv`, `.tsv`): decode utf-8;
 *  - `.docx`: o arquivo é um ZIP de XML — abrimos `word/document.xml` com
 *    `fflate` (puro JS, sem binário nativo) e concatenamos os nós `<w:t>`;
 *  - `.pdf`: texto via `unpdf` (build serverless do PDF.js), importado
 *    dinamicamente para o custo só existir em upload de PDF.
 *
 * PDF escaneado (foto de página) continua fora: sem camada de texto o
 * PDF.js devolve vazio e caímos no erro de "texto útil", em vez de
 * indexar lixo. Extrair aí exigiria OCR, que é outro projeto.
 *
 * Imagem também não entra — exigiria visão/OCR pelo mesmo motivo.
 *
 * O custo de extração é O(tamanho do arquivo) em memória e sem I/O de
 * rede — com o limite de 10 MB por upload isso fica na casa de dezenas de
 * ms para texto e docx. PDF é a exceção: o parse do PDF.js é bem mais
 * caro, por isso o teto de páginas em `MAX_PDF_PAGES`. Mesmo assim roda
 * inline no handler. O trabalho pesado de verdade (chunking + embeddings)
 * continua em background via `scheduleIndexing`.
 */

import { unzipSync } from "fflate";

/** Limite de bytes do arquivo enviado. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Limite de caracteres do texto extraído — mesmo do POST JSON. */
export const MAX_EXTRACTED_CHARS = 500_000;

/**
 * Teto de páginas do PDF. `extractText` percorre o documento inteiro na
 * mesma chamada, então um PDF de milhares de páginas seguraria o handler.
 * Um calendário/manual real não passa disso.
 */
export const MAX_PDF_PAGES = 300;

type SupportedExt =
  | "txt"
  | "md"
  | "markdown"
  | "csv"
  | "tsv"
  | "docx"
  | "pdf";

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
 * Texto do PDF via `unpdf`. O import é dinâmico porque o pacote embute o
 * PDF.js inteiro: quem sobe um `.txt` não paga esse carregamento.
 *
 * `mergePages` junta as páginas preservando as quebras — para RAG a
 * divisão por página não importa, o chunking refaz os cortes depois.
 */
async function extractPdf(buffer: Buffer): Promise<string> {
  let unpdf: typeof import("unpdf");
  try {
    unpdf = await import("unpdf");
  } catch {
    throw new KnowledgeExtractError(
      "Leitura de PDF indisponível neste servidor. Converta para .docx ou .txt e envie novamente.",
    );
  }

  let raw: string;
  try {
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new KnowledgeExtractError(
        `PDF com ${pdf.numPages} páginas (limite ${MAX_PDF_PAGES}). Divida o documento e envie por partes.`,
      );
    }
    const extracted = await unpdf.extractText(pdf, { mergePages: true });
    raw = Array.isArray(extracted.text)
      ? extracted.text.join("\n\n")
      : extracted.text;
  } catch (e) {
    if (e instanceof KnowledgeExtractError) throw e;
    throw new KnowledgeExtractError(
      "Não foi possível ler o PDF (arquivo corrompido ou protegido por senha).",
    );
  }

  return raw
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

  const text = PLAIN_TEXT_EXTS.has(supported)
    ? decodeText(buffer).trim()
    : supported === "pdf"
      ? await extractPdf(buffer)
      : extractDocx(buffer);

  if (text.length < 10) {
    throw new KnowledgeExtractError(
      supported === "pdf"
        ? "Este PDF não tem texto — provavelmente é digitalizado (foto das páginas). Envie a versão em texto ou converta para .docx."
        : "Não foi possível extrair texto útil do arquivo.",
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
