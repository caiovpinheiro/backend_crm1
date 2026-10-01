/**
 * Guardas de tamanho/assinatura para arquivos de importação (SEC2-4).
 *
 * XLSX/ODS são ZIPs: uma planilha "inflável" (zip bomb) ou um HTML
 * renomeado para .xls estoura CPU/memória do worker ETL e da API. Antes
 * de entregar os bytes ao SheetJS verificamos:
 *   1. teto de bytes por rota (`IMPORT_MAX_BYTES` / `ACADEMIC_IMPORT_MAX_BYTES`);
 *   2. assinatura real (`PK\x03\x04` para xlsx/ods, OLE2 para xls,
 *      texto sem NUL para csv);
 *   3. tamanho descomprimido declarado no diretório central do ZIP;
 *   4. teto de linhas ANTES do parse (contagem de quebras no CSV,
 *      `sheetRows` no SheetJS).
 *
 * Nenhuma dependência nova: a inspeção do ZIP lê só o End Of Central
 * Directory + entradas (`PK\x01\x02`), sem descomprimir nada.
 */

/** Contatos/empresas/negócios — a UI já limita em 10 MB; agora a API também. */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** Relatório de matriculados (academic-records). */
export const ACADEMIC_IMPORT_MAX_BYTES = 32 * 1024 * 1024;
/** Linhas de dados por importação (contatos/negócios). */
export const IMPORT_MAX_ROWS = 100_000;
/** Relatório de matriculados — base inteira da instituição. */
export const ACADEMIC_IMPORT_MAX_ROWS = 250_000;
/** Soma dos tamanhos descomprimidos declarados no ZIP (xlsx/ods). */
export const IMPORT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** Entradas no ZIP — planilha legítima tem dezenas, não milhares. */
export const IMPORT_MAX_ZIP_ENTRIES = 2_000;

export type ImportFileKind = "xlsx" | "xls" | "ods" | "csv";

export class ImportFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImportFileError";
    this.status = status;
  }
}

/** Deriva o tipo pela extensão do nome (única informação que o worker tem). */
export function importKindFromName(fileName: string): ImportFileKind | null {
  const lower = (fileName ?? "").trim().toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".xls")) return "xls";
  if (lower.endsWith(".ods")) return "ods";
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) return "csv";
  return null;
}

function startsWithBytes(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const OLE2_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isZipSignature(buf: Buffer): boolean {
  return startsWithBytes(buf, ZIP_LOCAL_HEADER);
}

export function isOle2Signature(buf: Buffer): boolean {
  return startsWithBytes(buf, OLE2_HEADER);
}

/** CSV "de verdade": sem NUL nos primeiros 8 KB. */
export function looksLikeCsvText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0x00) return false;
  return true;
}

export type ZipInspection = {
  entries: number;
  totalUncompressed: number;
  totalCompressed: number;
};

/**
 * Lê o diretório central do ZIP (sem descomprimir) e soma os tamanhos
 * declarados. Devolve `null` quando o EOCD não é encontrado (arquivo
 * truncado/corrompido — o SheetJS também falharia).
 */
export function inspectZipDirectory(buf: Buffer): ZipInspection | null {
  // EOCD: PK\x05\x06 nos últimos 22 bytes + comentário (≤ 64 KB).
  const minEocd = 22;
  if (buf.length < minEocd) return null;
  const searchStart = Math.max(0, buf.length - minEocd - 0xffff);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= searchStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entriesDeclared = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) return null;

  let pos = cdOffset;
  let entries = 0;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  const end = cdOffset + cdSize;
  while (pos + 46 <= end && entries < entriesDeclared) {
    if (!(buf[pos] === 0x50 && buf[pos + 1] === 0x4b && buf[pos + 2] === 0x01 && buf[pos + 3] === 0x02)) {
      break;
    }
    const compressed = buf.readUInt32LE(pos + 20);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    entries++;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, totalUncompressed, totalCompressed };
}

/**
 * Valida assinatura + estrutura do ZIP antes do parse. Lança
 * `ImportFileError` (400/413/415) — as rotas convertem em JSON.
 */
export function assertImportFileSignature(buf: Buffer, kind: ImportFileKind): void {
  if (buf.length === 0) throw new ImportFileError("Arquivo vazio.", 400);
  if (kind === "csv") {
    if (!looksLikeCsvText(buf)) {
      throw new ImportFileError("O arquivo não é um CSV de texto válido.", 415);
    }
    return;
  }
  if (kind === "xls") {
    // .xls legítimo é OLE2 (BIFF). Alguns exportadores gravam OOXML com
    // extensão .xls — aceitamos ZIP também; HTML/texto renomeado é recusado.
    if (!isOle2Signature(buf) && !isZipSignature(buf)) {
      throw new ImportFileError("O arquivo não é uma planilha .xls válida.", 415);
    }
    if (!isZipSignature(buf)) return;
  } else if (!isZipSignature(buf)) {
    throw new ImportFileError(
      `O arquivo não é uma planilha .${kind} válida (assinatura ZIP ausente).`,
      415,
    );
  }
  const zip = inspectZipDirectory(buf);
  if (!zip) {
    throw new ImportFileError("Planilha corrompida ou truncada.", 400);
  }
  if (zip.entries > IMPORT_MAX_ZIP_ENTRIES) {
    throw new ImportFileError("Planilha com estrutura inválida (entradas demais).", 413);
  }
  if (zip.totalUncompressed > IMPORT_MAX_UNCOMPRESSED_BYTES) {
    throw new ImportFileError(
      "Planilha grande demais depois de descomprimida. Exporte em CSV ou divida o arquivo.",
      413,
    );
  }
}

/**
 * Conta quebras de linha até `max + 1` (para parar cedo). Campos entre
 * aspas com quebra inflam a contagem — só torna o limite mais
 * conservador, nunca mais permissivo.
 */
export function countCsvLines(buf: Buffer, max: number): number {
  let lines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines++;
      if (lines > max) return lines;
    }
  }
  return lines;
}

/** Mensagem padrão de teto de bytes (usada nas rotas). */
export function importTooLargeMessage(maxBytes: number): string {
  return `Arquivo excede o limite de ${Math.round(maxBytes / 1024 / 1024)} MB.`;
}
