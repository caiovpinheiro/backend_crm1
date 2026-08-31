/**
 * Backend S3-compatible (DigitalOcean Spaces) do storage tenant-scoped.
 *
 * Ativado quando `STORAGE_DRIVER=s3` (ver dispatcher em `./local.ts`).
 * Implementa as mesmas operações do backend de disco local sobre um bucket
 * S3-compatible, mantendo o layout de chaves idêntico ao layout de pastas:
 *
 *   <organizationId>/<bucket>/<fileName>
 *
 * Isolamento multi-tenant
 * ───────────────────────
 * Os objetos são SEMPRE privados (sem ACL pública). Quem serve os bytes ao
 * usuário final é o gateway autenticado `/api/storage/[...path]/route.ts`,
 * que valida a org da sessão antes de chamar `readStoredFile` — o Spaces
 * nunca é exposto diretamente ao browser.
 *
 * Configuração (env):
 *
 *   S3_ENDPOINT   ex.: https://nyc3.digitaloceanspaces.com
 *   S3_REGION     região de assinatura do SDK AWS (default "us-east-1" —
 *                 exigência do SDK; a região real vem do endpoint).
 *   S3_BUCKET     nome do bucket/Space.
 *   S3_ACCESS_KEY / S3_SECRET   credenciais do Space.
 *
 * Este módulo é carregado LAZY pelo dispatcher (dynamic import) — com o
 * driver `local` ele nunca é importado e o SDK AWS nem entra em memória.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { getLogger } from "@/lib/logger";
import { metrics } from "@/lib/metrics";

import {
  assertBucket,
  buildPublicUrl,
  isValidFileName,
  isValidOrgId,
  mimeFromFilename,
  type ReadFileResult,
  type SaveFileOptions,
  type SaveFileResult,
  type StorageBucket,
  type StoredFileStat,
} from "./local";

const log = getLogger("storage.s3");

type S3Env = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secret: string;
};

function readS3Env(): S3Env {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKey = process.env.S3_ACCESS_KEY?.trim();
  const secret = process.env.S3_SECRET?.trim();
  const region = process.env.S3_REGION?.trim() || "us-east-1";
  if (!endpoint || !bucket || !accessKey || !secret) {
    throw new Error(
      "storage-s3: STORAGE_DRIVER=s3 exige S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY e S3_SECRET",
    );
  }
  return { endpoint, region, bucket, accessKey, secret };
}

let cached: { client: S3Client; bucket: string } | null = null;

function getS3(): { client: S3Client; bucket: string } {
  if (!cached) {
    const env = readS3Env();
    cached = {
      client: new S3Client({
        endpoint: env.endpoint,
        region: env.region,
        // Spaces (e S3-compatibles em geral) aceitam path-style; evita
        // depender de DNS virtual-hosted (<bucket>.<endpoint>).
        forcePathStyle: true,
        credentials: {
          accessKeyId: env.accessKey,
          secretAccessKey: env.secret,
        },
      }),
      bucket: env.bucket,
    };
  }
  return cached;
}

/**
 * Mesma validação do backend local (path traversal vira key traversal —
 * `..` e `/` em fileName continuam proibidos).
 */
function objectKey(orgId: string, bucket: StorageBucket, fileName: string): string {
  if (!isValidOrgId(orgId)) throw new Error(`storage: orgId invalido`);
  if (!isValidFileName(fileName)) throw new Error(`storage: fileName invalido`);
  return `${orgId}/${bucket}/${fileName}`;
}

function isNotFound(err: unknown): boolean {
  const e = err as Partial<S3ServiceException> & { name?: string };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchBucket" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

function countError(kind: string): void {
  try {
    metrics.errors.inc({ scope: "storage.s3", kind });
  } catch {
    // métrica nunca derruba I/O
  }
}

/**
 * Salva (sobrescreve) o objeto. Usa `Upload` (lib-storage): buffers acima
 * de ~5MB viram multipart upload automaticamente — gravações de chamada e
 * vídeos inbound passam de dezenas de MB.
 */
export async function saveFile(opts: SaveFileOptions): Promise<SaveFileResult> {
  assertBucket(opts.bucket);
  const key = objectKey(opts.orgId, opts.bucket, opts.fileName);
  const { client, bucket } = getS3();
  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: opts.buffer,
        ContentType: mimeFromFilename(opts.fileName),
        // Sem ACL: objeto permanece PRIVADO (default do bucket). Nunca
        // public-read — quem serve é o gateway autenticado.
      },
    });
    await upload.done();
  } catch (err) {
    log.error({ err, key }, "storage-s3: falha ao gravar objeto");
    countError("save");
    throw err;
  }
  const confirmed = await probeStoredFile(opts.orgId, opts.bucket, opts.fileName);
  if (!confirmed) {
    log.error({ key }, "storage-s3: upload.done sem objeto confirmado");
    countError("save_unconfirmed");
    throw new Error("storage-s3: arquivo não ficou disponível no Spaces após o upload");
  }
  return {
    url: buildPublicUrl(opts.orgId, opts.bucket, opts.fileName),
    // Não há disco — devolvemos a referência s3:// para logs/debug
    // (campo documentado como "só para logs/debug" no contrato).
    absolutePath: `s3://${bucket}/${key}`,
  };
}

/** Head (ou Get range) — existência sem baixar o body. */
export async function probeStoredFile(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<boolean> {
  const st = await statStoredFile(orgId, bucket, fileName);
  return st != null;
}

function fileStem(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

export type ListedOrgObject = {
  bucket: StorageBucket;
  fileName: string;
};

/**
 * Lista keys da org cujo filename começa com o stem (`auto_ts_rand`).
 * Só prefixo `<orgId>/<bucket>/` — sem escape de tenant.
 */
export async function findOrgObjectByStem(
  orgId: string,
  buckets: readonly StorageBucket[],
  fileName: string,
): Promise<ListedOrgObject | null> {
  if (!isValidOrgId(orgId) || !isValidFileName(fileName)) return null;
  const stem = fileStem(fileName);
  if (stem.length < 4) return null;
  const { client, bucket: bucketName } = getS3();

  const searches = buckets.map(async (mediaBucket) => {
    const prefix = `${orgId}/${mediaBucket}/${stem}`;
    try {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          MaxKeys: 8,
        }),
      );
      for (const obj of out.Contents ?? []) {
        const key = obj.Key;
        if (!key) continue;
        const parts = key.split("/");
        if (parts.length !== 3) continue;
        const [o, b, name] = parts;
        if (o !== orgId || b !== mediaBucket || !isValidFileName(name)) continue;
        return { bucket: mediaBucket, fileName: name };
      }
    } catch (err) {
      log.warn({ err, prefix }, "storage-s3: ListObjects falhou");
    }
    return null;
  });

  const found = await Promise.all(searches);
  return found.find((hit): hit is ListedOrgObject => hit != null) ?? null;
}

/**
 * Lê o objeto inteiro. Devolve null se não encontrado — mesmo contrato do
 * backend local. Erros de infra (rede/auth/5xx) são logados + contados em
 * `crm_errors_total` e também viram null (caller responde 404 como no
 * driver local).
 */
export async function readStoredFile(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<ReadFileResult | null> {
  let key: string;
  try {
    key = objectKey(orgId, bucket, fileName);
  } catch {
    return null;
  }
  const { client, bucket: bucketName } = getS3();
  // Duas tentativas: Spaces às vezes devolve GetObject sem Body / stream
  // quebrado em JPEG pequeno (Head/Range já 404) enquanto o retry serve.
  // GET /api/storage e o POST reuseUrl passam por aqui — o mesmo read.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
      if (!out.Body) {
        log.warn({ key, attempt }, "storage-s3: GetObject sem Body");
        if (attempt === 0) continue;
        return null;
      }
      const buffer = Buffer.from(await out.Body.transformToByteArray());
      if (!buffer.length && (contentLengthToSize(out.ContentLength) ?? 0) > 0) {
        log.warn({ key, attempt, contentLength: out.ContentLength }, "storage-s3: GetObject body vazio");
        if (attempt === 0) continue;
        return null;
      }
      return {
        buffer,
        size: out.ContentLength ?? buffer.length,
        mimeType: mimeFromFilename(fileName),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      if (attempt === 0) {
        log.warn({ err, key }, "storage-s3: GetObject falhou, tentando de novo");
        continue;
      }
      log.error({ err, key }, "storage-s3: falha ao ler objeto");
      countError("read");
      return null;
    }
  }
  return null;
}

function contentLengthToSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** `Content-Range: bytes 0-0/12345` → 12345. */
function sizeFromContentRange(value: string | undefined): number | null {
  if (!value) return null;
  const m = /\/(\d+)\s*$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Aborta o body do GetObject — existência não pode baixar o mp4 inteiro. */
function abortS3Body(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const stream = body as {
    destroy?: (err?: Error) => void;
    cancel?: () => void | Promise<void>;
  };
  try {
    if (typeof stream.destroy === "function") {
      stream.destroy();
      return;
    }
    if (typeof stream.cancel === "function") {
      void stream.cancel();
    }
  } catch {
    // best-effort
  }
}

async function confirmGetObjectExists(
  client: S3Client,
  bucketName: string,
  key: string,
): Promise<StoredFileStat | null> {
  // Duas tentativas: mesmo flake JPEG (GetObject vazio / 404 transitório).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
      if (!out.Body) {
        if (attempt === 0) continue;
        return null;
      }
      const size = contentLengthToSize(out.ContentLength) ?? 0;
      abortS3Body(out.Body);
      return { size: size > 0 ? size : 1 };
    } catch (err) {
      if (isNotFound(err)) {
        if (attempt === 0) continue;
        return null;
      }
      if (attempt === 0) {
        log.warn({ err, key }, "storage-s3: GetObject existência falhou, tentando de novo");
        continue;
      }
      log.error({ err, key }, "storage-s3: falha no GetObject de existência");
      countError("stat");
      return null;
    }
  }
  return null;
}

/**
 * Tamanho do objeto sem baixar o corpo. HeadObject primeiro; se o
 * compat (Spaces) omitir ContentLength, negar HEAD, 404 em HEAD de
 * objeto que o GET serve, ou falhar, confirma com GetObject Range —
 * o mesmo I/O que o GET /api/storage usa quando o stat falha e o
 * read passa. Não tratar Head 404 como miss definitivo.
 */
export async function statStoredFile(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<StoredFileStat | null> {
  let key: string;
  try {
    key = objectKey(orgId, bucket, fileName);
  } catch {
    return null;
  }
  const { client, bucket: bucketName } = getS3();
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    const size = contentLengthToSize(out.ContentLength);
    // Head 200 sem ContentLength ainda significa "existe" — GET /api/storage
    // seguiria para GetObject. Não tratar como miss.
    return { size: size ?? 0 };
  } catch (err) {
    log.warn({ err, key }, "storage-s3: HeadObject falhou, tentando GetObject range");
    try {
      const ranged = await client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
          Range: "bytes=0-0",
        }),
      );
      const size =
        sizeFromContentRange(ranged.ContentRange) ??
        contentLengthToSize(ranged.ContentLength) ??
        0;
      return { size };
    } catch (rangeErr) {
      // Head/Range 404 em objeto que o GET sem Range serve (JPEG e mp4).
      // Não tratar Range 404 como miss — confirma com GetObject e aborta o body.
      log.warn({ err: rangeErr, key }, "storage-s3: GetObject range falhou, tentando GetObject sem Range");
      return confirmGetObjectExists(client, bucketName, key);
    }
  }
}

/**
 * Lê um slice [start, end] (inclusive) via `Range` nativo do S3 — usado
 * pelo gateway para HTTP 206 em `<video>`/`<audio>` sem baixar o objeto
 * inteiro. `size` no resultado é o número de bytes do slice.
 */
export async function readStoredFileRange(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
  start: number,
  end: number,
): Promise<ReadFileResult | null> {
  let key: string;
  try {
    key = objectKey(orgId, bucket, fileName);
  } catch {
    return null;
  }
  const { client, bucket: bucketName } = getS3();
  try {
    const out = await client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
        Range: `bytes=${start}-${end}`,
      }),
    );
    if (!out.Body) return null;
    const buffer = Buffer.from(await out.Body.transformToByteArray());
    return {
      buffer,
      size: buffer.length,
      mimeType: mimeFromFilename(fileName),
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    log.error({ err, key, start, end }, "storage-s3: falha no range read");
    countError("read_range");
    return null;
  }
}
