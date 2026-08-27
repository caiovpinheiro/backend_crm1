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
  return {
    url: buildPublicUrl(opts.orgId, opts.bucket, opts.fileName),
    // Não há disco — devolvemos a referência s3:// para logs/debug
    // (campo documentado como "só para logs/debug" no contrato).
    absolutePath: `s3://${bucket}/${key}`,
  };
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
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    if (!out.Body) return null;
    const buffer = Buffer.from(await out.Body.transformToByteArray());
    return {
      buffer,
      size: out.ContentLength ?? buffer.length,
      mimeType: mimeFromFilename(fileName),
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    log.error({ err, key }, "storage-s3: falha ao ler objeto");
    countError("read");
    return null;
  }
}

/** Tamanho do objeto sem baixar o corpo (HeadObject). Null se ausente. */
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
    if (typeof out.ContentLength !== "number") return null;
    return { size: out.ContentLength };
  } catch (err) {
    if (isNotFound(err)) return null;
    log.error({ err, key }, "storage-s3: falha no HeadObject");
    countError("stat");
    return null;
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
