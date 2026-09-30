/**
 * Detecção de tipo de arquivo por magic bytes (defesa em profundidade
 * contra upload de conteúdo malicioso).
 *
 * O `Content-Type` do multipart vem do cliente e é trivialmente
 * falsificável — não deve ser usado sozinho para autorizar armazenar
 * o arquivo nem para derivar a extensão. Estas funções olham o cabeçalho
 * binário real e retornam o tipo canonicalizado, ou `null` se o
 * conteúdo não bate com nenhum formato permitido.
 *
 * Formatos suportados aqui refletem o que o CRM precisa aceitar. SVG,
 * HTML, arquivos executáveis, PDFs criptografados etc. caem em `null`
 * e devem ser rejeitados pelo caller.
 */

export type SniffedImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type SniffedVideoMime = "video/mp4" | "video/webm" | "video/quicktime";
export type SniffedAudioMime =
  | "audio/mpeg"
  | "audio/mp4"
  | "audio/ogg"
  | "audio/webm"
  | "audio/wav";
export type SniffedDocMime = "application/pdf";

export type SniffedMime =
  | SniffedImageMime
  | SniffedVideoMime
  | SniffedAudioMime
  | SniffedDocMime;

function eq(buf: Buffer, offset: number, bytes: number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

export function sniffImageMime(buf: Buffer): SniffedImageMime | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (eq(buf, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (eq(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // WEBP: "RIFF" .... "WEBP"
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  // GIF: "GIF87a" ou "GIF89a"
  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") {
    return "image/gif";
  }
  // SVG e outros formatos texto/vetoriais caem aqui como null e devem
  // ser rejeitados — SVG pode conter <script> e é vetor XSS quando
  // servido como image/svg+xml sob a mesma origem.
  return null;
}

export function sniffVideoMime(buf: Buffer): SniffedVideoMime | null {
  if (buf.length < 12) return null;
  // MP4/MOV: "....ftyp...."
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    // isom, mp42, mp41, avc1, iso2, M4V, etc → mp4
    return "video/mp4";
  }
  // WebM/Matroska: 1A 45 DF A3
  if (eq(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

export function sniffAudioMime(buf: Buffer): SniffedAudioMime | null {
  if (buf.length < 12) return null;
  // MP3 com ID3v2: "ID3"
  if (buf.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  // MP3 frame sync: FF Ex/Fx
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";
  // WAV: "RIFF"...."WAVE"
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return "audio/wav";
  }
  // OGG: "OggS"
  if (buf.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  // M4A: "....ftypM4A "
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand.startsWith("M4A")) return "audio/mp4";
  }
  // WebM (áudio compartilha o mesmo container)
  if (eq(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  return null;
}

export function sniffDocMime(buf: Buffer): SniffedDocMime | null {
  if (buf.length < 5) return null;
  // PDF: "%PDF-"
  if (buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

export function extForMime(mime: SniffedMime): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "weba";
    case "audio/wav":
      return "wav";
    case "application/pdf":
      return "pdf";
  }
}

// ──────────────────────────────────────────────────────────────────────
// Anexos genéricos (Bwipo Chat, conversas, Keeps) — SEC2-3
// ──────────────────────────────────────────────────────────────────────

export type AttachmentSniff = {
  /** MIME canonicalizado a partir dos magic bytes. */
  mime: string;
  /** Extensão derivada do MIME detectado (nunca do nome enviado). */
  ext: string;
};

export type AttachmentHint = {
  /** `Content-Type` declarado pelo cliente (só desempata containers ambíguos). */
  mime?: string | null;
  /** Nome enviado pelo cliente (só desempata containers ambíguos). */
  fileName?: string | null;
};

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const OOXML_BY_EXT: Record<string, AttachmentSniff> = {
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: "pptx",
  },
};

const OLE2_BY_EXT: Record<string, AttachmentSniff> = {
  doc: { mime: "application/msword", ext: "doc" },
  xls: { mime: "application/vnd.ms-excel", ext: "xls" },
  ppt: { mime: "application/vnd.ms-powerpoint", ext: "ppt" },
};

const ODF_BY_MIME: Record<string, string> = {
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};

function hintExt(hint: AttachmentHint): string {
  const name = (hint.fileName ?? "").trim().toLowerCase();
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).replace(/[^a-z0-9]/g, "");
}

function hintMime(hint: AttachmentHint): string {
  return (hint.mime ?? "").split(";")[0].trim().toLowerCase();
}

/** Texto "de verdade": sem NUL, poucos bytes de controle, e não parece HTML/SVG/XML. */
function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0x00) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control++;
  }
  if (control > n * 0.02) return false;
  const head = buf
    .toString("utf8", 0, Math.min(buf.length, 512))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();
  if (/^<(!doctype|html|svg|\?xml|script|body|head|iframe)/.test(head)) return false;
  return true;
}

/**
 * Detecta o tipo REAL de um anexo pelos magic bytes e devolve MIME +
 * extensão canônicos. `hint` (Content-Type/nome do cliente) só serve
 * para desempatar containers ambíguos (mp4 áudio×vídeo, zip docx×xlsx,
 * texto txt×csv) — nunca para autorizar um tipo que os bytes não
 * confirmam. `null` = conteúdo não reconhecido (exe, html, svg, js…).
 */
export function sniffAttachment(buf: Buffer, hint: AttachmentHint = {}): AttachmentSniff | null {
  if (buf.length < 4) return null;
  const hMime = hintMime(hint);
  const hExt = hintExt(hint);
  const wantsAudio = hMime.startsWith("audio/");

  const img = sniffImageMime(buf);
  if (img) return { mime: img, ext: extForMime(img) };

  const pdf = sniffDocMime(buf);
  if (pdf) return { mime: pdf, ext: "pdf" };

  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF") {
    const form = buf.toString("ascii", 8, 12);
    if (form === "WAVE") return { mime: "audio/wav", ext: "wav" };
    return null;
  }

  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "qt  ") return { mime: "video/quicktime", ext: "mov" };
    if (brand.startsWith("M4A")) return { mime: "audio/mp4", ext: "m4a" };
    if (brand.startsWith("3gp")) return { mime: "video/3gpp", ext: "3gp" };
    if (wantsAudio) return { mime: "audio/mp4", ext: "m4a" };
    return { mime: "video/mp4", ext: "mp4" };
  }

  if (eq(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return wantsAudio
      ? { mime: "audio/webm", ext: "webm" }
      : { mime: "video/webm", ext: "webm" };
  }

  if (buf.toString("ascii", 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (buf.length >= 6 && buf.toString("ascii", 0, 6) === "#!AMR\n") {
    return { mime: "audio/amr", ext: "amr" };
  }
  if (buf.toString("ascii", 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    // Frame sync MPEG (mp3) — ADTS/AAC também cai aqui; respeita o hint.
    if (hMime === "audio/aac" || hExt === "aac") return { mime: "audio/aac", ext: "aac" };
    return { mime: "audio/mpeg", ext: "mp3" };
  }

  if (eq(buf, 0, OLE2_MAGIC)) {
    const byExt = OLE2_BY_EXT[hExt];
    if (byExt) return byExt;
    const byMime = Object.values(OLE2_BY_EXT).find((d) => d.mime === hMime);
    return byMime ?? OLE2_BY_EXT.doc;
  }

  if (eq(buf, 0, ZIP_MAGIC)) {
    const head = buf.toString("latin1", 0, Math.min(buf.length, 4096));
    // ODF: primeira entrada é `mimetype` sem compressão, seguida do MIME.
    if (head.startsWith("mimetype", 30)) {
      const odfMime = Object.keys(ODF_BY_MIME).find((m) => head.startsWith(m, 38));
      if (odfMime) return { mime: odfMime, ext: ODF_BY_MIME[odfMime] };
    }
    const isOoxml = head.includes("[Content_Types].xml");
    if (isOoxml) {
      const byExt = OOXML_BY_EXT[hExt];
      if (byExt) return byExt;
      const byMime = Object.values(OOXML_BY_EXT).find((d) => d.mime === hMime);
      if (byMime) return byMime;
    }
    return { mime: "application/zip", ext: "zip" };
  }

  if (looksLikeText(buf)) {
    if (hExt === "csv" || hMime === "text/csv") return { mime: "text/csv", ext: "csv" };
    return { mime: "text/plain", ext: "txt" };
  }

  return null;
}
