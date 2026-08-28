/**
 * Storage local prefixado por organização — PR 1.3 (multi-tenancy hardening).
 *
 * Antes deste módulo, todos os uploads (anexos de conversa, mídias de
 * automação, avatares, gravações de chamada, mídias inbound do Meta/
 * Baileys) eram gravados em `public/uploads/<file>` — servido como
 * static-file pelo Next, **sem validação de tenant nem autenticação**.
 * Isso significava que (a) qualquer pessoa na internet com o filename
 * acessava as mídias direto, e (b) qualquer usuário autenticado de
 * qualquer org acessava mídias de qualquer outra org.
 *
 * Layout novo:
 *
 *   <STORAGE_ROOT>/<organizationId>/<bucket>/<fileName>
 *
 * Buckets (whitelist em `BUCKETS`):
 *
 *   - `attachments`       anexos enviados pelo agente (POST /conversations/[id]/attachments)
 *   - `recordings`        gravações de chamada (POST /conversations/[id]/whatsapp-calls/recording)
 *   - `automation-media`  mídias usadas em steps de automação
 *   - `avatars`           avatares de usuário (User.avatarUrl)
 *   - `contact-avatars`   avatares de contato sincronizados via WhatsApp (Contact.avatarUrl)
 *   - `inbound-media`     mídias recebidas via webhook Meta / Baileys
 *
 * URLs públicas:
 *
 *   /api/storage/<organizationId>/<bucket>/<fileName>
 *
 * Servidas por `/app/api/storage/[...path]/route.ts`, que valida que a
 * sessão atual pertence a `organizationId` (ou é super-admin) antes de
 * entregar o byte.
 *
 * Configuração:
 *
 *   STORAGE_ROOT (env, opcional)
 *     Diretório raiz absoluto. Default: `<cwd>/storage`.
 *     Em produção (container) recomenda-se `/app/storage` montado
 *     como volume persistente separado de `public/uploads` legacy.
 *
 * Kill switch de backend (STORAGE_DRIVER)
 * ───────────────────────────────────────
 * Este módulo é um DISPATCHER: a interface pública (`saveFile`,
 * `readStoredFile`, `statStoredFile`, `readStoredFileRange`,
 * `buildPublicUrl`, `parseStoragePath`, `resolveStoragePath`) é única e
 * o backend concreto é escolhido por env:
 *
 *   STORAGE_DRIVER=local  (default) → disco local em STORAGE_ROOT
 *                                     (comportamento histórico).
 *   STORAGE_DRIVER=s3               → bucket S3-compatible (DigitalOcean
 *                                     Spaces), implementado em `./s3.ts`
 *                                     e carregado lazy (o SDK AWS só entra
 *                                     em memória com o driver ativo).
 *
 * Com `s3`, `resolveStoragePath`/`storageRoot` não têm significado (não há
 * disco) — só o backend local os usa. `buildPublicUrl` continua gerando
 * `/api/storage/<org>/<bucket>/<file>` em ambos: o gateway autenticado é
 * quem serve os bytes, preservando o isolamento multi-tenant (o bucket
 * nunca é exposto por URL pública).
 *
 * @see docs/storage-tenancy.md
 */
import { mkdir, open, readFile, stat, writeFile } from "fs/promises";
import path from "path";

export const BUCKETS = [
  "attachments",
  "recordings",
  "automation-media",
  "avatars",
  "contact-avatars",
  "inbound-media",
  // Identidade visual da organização (Organization.logoUrl) — ícone/logo
  // da empresa exibido na navrail.
  "branding",
  // PR 4.3 — exports LGPD/GDPR. Auto-deletado pelo job de limpeza
  // depois de DataRequest.expiresAt (default +7 dias).
  "data-exports",
  // ETL — arquivos de importação (CSV/XLSX) enviados pela tela de contatos.
  // Lidos pelo etl-worker via readStoredFile no volume compartilhado.
  "imports",
] as const;
export type StorageBucket = (typeof BUCKETS)[number];

const URL_PREFIX = "/api/storage/";

/**
 * Tabela MIME → extensão usada quando o caller não fornece nome com
 * extensão. Mantemos uma versão própria (em vez de reaproveitar a do
 * meta-webhook handler) pra desacoplar storage de Meta.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/opus": "opus",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv",
};

const EXT_TO_MIME: Record<string, string> = (() => {
  const acc: Record<string, string> = {};
  for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
    if (!acc[ext]) acc[ext] = mime;
  }
  acc["jpg"] = "image/jpeg";
  acc["jpeg"] = "image/jpeg";
  acc["mov"] = "video/quicktime";
  return acc;
})();

export function mimeToExt(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? base.split("/").pop()?.replace(/[^a-z0-9]/g, "") ?? "bin";
}

export function mimeFromFilename(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = fileName.slice(idx + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/**
 * Diretório raiz absoluto de storage. Lê `STORAGE_ROOT` da env ou usa
 * `<cwd>/storage` como default.
 */
export function storageRoot(): string {
  const fromEnv = process.env.STORAGE_ROOT?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
  return path.resolve(process.cwd(), "storage");
}

/**
 * Valida bucket. Lança se não estiver na whitelist — não usar `as
 * StorageBucket` cego do caller.
 */
export function assertBucket(bucket: string): asserts bucket is StorageBucket {
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw new Error(`storage: bucket invalido "${bucket}"`);
  }
}

/**
 * Valida `organizationId`: somente caracteres seguros (cuid/uuid + `_`
 * pra fallback). Bloqueia path traversal já no parse.
 */
export function isValidOrgId(orgId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(orgId);
}

/**
 * Valida `fileName`: sem traversal, sem slashes, sem null bytes. Aceita
 * subdiretórios não — se precisar, crie um bucket novo.
 */
export function isValidFileName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  if (/[\0\r\n]/.test(name)) return false;
  return true;
}

/**
 * Resolve o caminho absoluto no disco para `(orgId, bucket, fileName)`.
 * Não verifica existência. Não permite `..` nem `/` em fileName.
 */
export function resolveStoragePath(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): string {
  if (!isValidOrgId(orgId)) throw new Error(`storage: orgId invalido`);
  if (!isValidFileName(fileName)) throw new Error(`storage: fileName invalido`);
  const abs = path.join(storageRoot(), orgId, bucket, fileName);
  // Defesa em profundidade: se o path resolvido sair da raiz, aborta.
  const root = storageRoot();
  const normalized = path.resolve(abs);
  if (!normalized.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`storage: path traversal detectado`);
  }
  return normalized;
}

/**
 * Constrói a URL pública (via gateway autenticado) para um arquivo.
 * Esta é a URL que vai pro DB (Message.mediaUrl, User.avatarUrl, etc).
 */
export function buildPublicUrl(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): string {
  if (!isValidOrgId(orgId)) throw new Error(`storage: orgId invalido`);
  if (!isValidFileName(fileName)) throw new Error(`storage: fileName invalido`);
  return `${URL_PREFIX}${orgId}/${bucket}/${encodeURIComponent(fileName)}`;
}

/**
 * Parser inverso do `buildPublicUrl`. Aceita também caminhos absolutos
 * sem prefixo (`<orgId>/<bucket>/<file>`) usados pelo gateway interno.
 *
 * Devolve null se o formato for inválido ou se algum segmento falhar
 * validação. Não acessa disco.
 */
export function parseStoragePath(input: string): {
  orgId: string;
  bucket: StorageBucket;
  fileName: string;
} | null {
  if (!input) return null;
  let trimmed = input.trim();
  if (trimmed.startsWith(URL_PREFIX)) trimmed = trimmed.slice(URL_PREFIX.length);
  // Aceita também `?...` query string e fragments — descarta.
  const qIdx = trimmed.indexOf("?");
  if (qIdx >= 0) trimmed = trimmed.slice(0, qIdx);
  const hIdx = trimmed.indexOf("#");
  if (hIdx >= 0) trimmed = trimmed.slice(0, hIdx);
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  // Permite fileName contendo "/" decodificado? Não — fileName não pode
  // ter "/" (ver isValidFileName). Pegamos apenas os 3 primeiros e
  // exigimos que não haja extras.
  if (segments.length > 3) return null;
  const [orgIdRaw, bucketRaw, fileNameRaw] = segments;
  if (!isValidOrgId(orgIdRaw)) return null;
  if (!(BUCKETS as readonly string[]).includes(bucketRaw)) return null;
  let fileName: string;
  try {
    fileName = decodeURIComponent(fileNameRaw);
  } catch {
    return null;
  }
  if (!isValidFileName(fileName)) return null;
  return { orgId: orgIdRaw, bucket: bucketRaw as StorageBucket, fileName };
}

export type SaveFileOptions = {
  orgId: string;
  bucket: StorageBucket;
  fileName: string;
  buffer: Buffer;
};

export type SaveFileResult = {
  /** URL relativa pública (pro DB e pro client). */
  url: string;
  /** Path absoluto no disco (driver local) ou ref `s3://…` (driver s3). Use só para logs/debug. */
  absolutePath: string;
};

export type ReadFileResult = {
  buffer: Buffer;
  mimeType: string;
  size: number;
};

/** Metadata mínima de um objeto armazenado (usada pelo gateway p/ Range). */
export type StoredFileStat = {
  size: number;
};

// ─── Dispatcher de backend (kill switch) ────────────────────────────────

export type StorageDriver = "local" | "s3";

/**
 * Backend ativo. Default `local` (comportamento histórico) — qualquer
 * valor diferente de "s3" cai no disco local, então voltar é só remover
 * a env (sem rebuild de lógica).
 */
export function storageDriver(): StorageDriver {
  return process.env.STORAGE_DRIVER?.trim().toLowerCase() === "s3" ? "s3" : "local";
}

/**
 * Salva um arquivo no storage tenant-scoped. Cria diretórios
 * intermediários conforme necessário. **Sobrescreve** se já existir.
 */
export async function saveFile(opts: SaveFileOptions): Promise<SaveFileResult> {
  if (storageDriver() === "s3") {
    const s3 = await import("./s3");
    return s3.saveFile(opts);
  }
  return saveFileLocal(opts);
}

/**
 * Lê um arquivo do storage. Devolve null se não encontrado. Caller é
 * responsável por validar a autorização (sessão pertence ao orgId)
 * ANTES de chamar — esta função é puramente de I/O.
 */
export async function readStoredFile(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<ReadFileResult | null> {
  if (storageDriver() === "s3") {
    const s3 = await import("./s3");
    return s3.readStoredFile(orgId, bucket, fileName);
  }
  return readStoredFileLocal(orgId, bucket, fileName);
}

/**
 * Tamanho do arquivo sem baixar o conteúdo (fs.stat / HeadObject).
 * Devolve null se não encontrado.
 */
export async function statStoredFile(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<StoredFileStat | null> {
  if (storageDriver() === "s3") {
    const s3 = await import("./s3");
    return s3.statStoredFile(orgId, bucket, fileName);
  }
  return statStoredFileLocal(orgId, bucket, fileName);
}

/**
 * Lê o slice [start, end] (inclusive) — usado pelo gateway para HTTP 206
 * (Range) de vídeo/áudio. No driver s3 o Range é repassado ao GetObject
 * (não baixa o objeto inteiro). `size` no resultado é o tamanho do slice.
 */
export async function readStoredFileRange(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
  start: number,
  end: number,
): Promise<ReadFileResult | null> {
  if (storageDriver() === "s3") {
    const s3 = await import("./s3");
    return s3.readStoredFileRange(orgId, bucket, fileName, start, end);
  }
  return readStoredFileRangeLocal(orgId, bucket, fileName, start, end);
}

// ─── Backend local (disco) ──────────────────────────────────────────────

async function saveFileLocal(opts: SaveFileOptions): Promise<SaveFileResult> {
  assertBucket(opts.bucket);
  const absolutePath = resolveStoragePath(opts.orgId, opts.bucket, opts.fileName);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, opts.buffer);
  return {
    url: buildPublicUrl(opts.orgId, opts.bucket, opts.fileName),
    absolutePath,
  };
}

async function readStoredFileLocal(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<ReadFileResult | null> {
  let absolutePath: string;
  try {
    absolutePath = resolveStoragePath(orgId, bucket, fileName);
  } catch {
    return null;
  }
  try {
    const s = await stat(absolutePath);
    if (!s.isFile()) return null;
    const buffer = await readFile(absolutePath);
    return {
      buffer,
      size: s.size,
      mimeType: mimeFromFilename(fileName),
    };
  } catch {
    return null;
  }
}

async function statStoredFileLocal(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<StoredFileStat | null> {
  let absolutePath: string;
  try {
    absolutePath = resolveStoragePath(orgId, bucket, fileName);
  } catch {
    return null;
  }
  try {
    const s = await stat(absolutePath);
    if (!s.isFile()) return null;
    return { size: s.size };
  } catch {
    return null;
  }
}

async function readStoredFileRangeLocal(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
  start: number,
  end: number,
): Promise<ReadFileResult | null> {
  let absolutePath: string;
  try {
    absolutePath = resolveStoragePath(orgId, bucket, fileName);
  } catch {
    return null;
  }
  try {
    const chunkSize = end - start + 1;
    const buffer = Buffer.alloc(chunkSize);
    const fh = await open(absolutePath, "r");
    try {
      await fh.read(buffer, 0, chunkSize, start);
    } finally {
      await fh.close();
    }
    return {
      buffer,
      size: chunkSize,
      mimeType: mimeFromFilename(fileName),
    };
  } catch {
    return null;
  }
}

/**
 * Helpers para gerar nomes de arquivo seguros.
 */
export function generateFileName(opts: {
  prefix?: string;
  ext: string;
  suffix?: string;
}): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = opts.ext.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const prefix = (opts.prefix ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const suffix = (opts.suffix ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const parts = [prefix, ts.toString(), rand, suffix].filter(Boolean);
  return `${parts.join("_")}.${ext}`;
}
