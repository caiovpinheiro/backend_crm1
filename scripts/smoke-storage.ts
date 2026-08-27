/**
 * Smoke test do storage tenant-scoped — roda contra o driver configurado
 * via env (`STORAGE_DRIVER=local` default, ou `s3` para DigitalOcean
 * Spaces). Cobre o contrato completo do módulo `src/lib/storage/local.ts`:
 *
 *   saveFile → statStoredFile → readStoredFile → readStoredFileRange
 *   → buildPublicUrl → cleanup (delete) → verifica ausência.
 *
 * Uso:
 *   # driver local (disco em STORAGE_ROOT ou ./storage):
 *   npx tsx scripts/smoke-storage.ts
 *
 *   # driver s3 (Spaces real — credenciais via env, NUNCA hardcoded):
 *   STORAGE_DRIVER=s3 S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
 *   S3_BUCKET=<bucket> S3_ACCESS_KEY=<key> S3_SECRET=<secret> \
 *   npx tsx scripts/smoke-storage.ts
 *
 * Exit 0 = PASS, 1 = FAIL. O arquivo de teste é sempre removido no final
 * (DeleteObject no s3 / unlink no local).
 */
import { unlink } from "fs/promises";

import {
  buildPublicUrl,
  generateFileName,
  readStoredFile,
  readStoredFileRange,
  resolveStoragePath,
  saveFile,
  statStoredFile,
  storageDriver,
} from "../src/lib/storage/local";

const ORG_ID = "smoketest";
const BUCKET = "attachments" as const;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert falhou: ${msg}`);
}

async function cleanup(driver: string, fileName: string): Promise<void> {
  if (driver === "s3") {
    const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION?.trim() || "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? "",
        secretAccessKey: process.env.S3_SECRET ?? "",
      },
    });
    await client.send(
      new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET ?? "",
        Key: `${ORG_ID}/${BUCKET}/${fileName}`,
      }),
    );
    return;
  }
  await unlink(resolveStoragePath(ORG_ID, BUCKET, fileName));
}

async function main(): Promise<void> {
  const driver = storageDriver();
  const fileName = generateFileName({ prefix: "smoke", ext: "txt" });
  const content = Buffer.from(
    `smoke-${driver}-${Date.now()}-conteudo-de-teste-✓`,
    "utf8",
  );

  console.log(`[smoke] driver=${driver} file=${ORG_ID}/${BUCKET}/${fileName} bytes=${content.length}`);

  // 1. save
  const saved = await saveFile({ orgId: ORG_ID, bucket: BUCKET, fileName, buffer: content });
  console.log(`[smoke] saveFile OK url=${saved.url} ref=${saved.absolutePath}`);
  assert(saved.url === buildPublicUrl(ORG_ID, BUCKET, fileName), "url pública divergente");
  assert(saved.url.startsWith(`/api/storage/${ORG_ID}/${BUCKET}/`), "url fora do gateway");

  try {
    // 2. stat
    const stat = await statStoredFile(ORG_ID, BUCKET, fileName);
    assert(stat && stat.size === content.length, `stat divergente: ${JSON.stringify(stat)}`);
    console.log(`[smoke] statStoredFile OK size=${stat.size}`);

    // 3. read full
    const read = await readStoredFile(ORG_ID, BUCKET, fileName);
    assert(read, "readStoredFile devolveu null");
    assert(read.buffer.equals(content), "conteúdo lido diverge do gravado");
    assert(read.size === content.length, "size divergente");
    assert(read.mimeType === "text/plain", `mime divergente: ${read.mimeType}`);
    console.log(`[smoke] readStoredFile OK (${read.size}b, ${read.mimeType})`);

    // 4. range read (bytes 5..12 inclusive)
    const range = await readStoredFileRange(ORG_ID, BUCKET, fileName, 5, 12);
    const expectedSlice = content.subarray(5, 13);
    assert(range, "readStoredFileRange devolveu null");
    assert(range.buffer.equals(expectedSlice), "slice do range diverge");
    console.log(`[smoke] readStoredFileRange OK bytes=5-12 ("${range.buffer.toString("utf8")}")`);

    // 5. parse da URL gerada (round-trip)
    const { parseStoragePath } = await import("../src/lib/storage/local");
    const parsed = parseStoragePath(saved.url);
    assert(
      parsed && parsed.orgId === ORG_ID && parsed.bucket === BUCKET && parsed.fileName === fileName,
      "parseStoragePath não fez round-trip",
    );
    console.log("[smoke] parseStoragePath round-trip OK");
  } finally {
    // 6. cleanup — sempre roda, mesmo se um assert falhar no meio.
    await cleanup(driver, fileName);
    console.log(`[smoke] cleanup OK (${driver === "s3" ? "DeleteObject" : "unlink"})`);
  }

  // 7. confirma ausência pós-cleanup
  const gone = await readStoredFile(ORG_ID, BUCKET, fileName);
  assert(gone === null, "arquivo ainda existe após cleanup");
  console.log("[smoke] pós-cleanup: arquivo ausente OK");
  console.log("[smoke] PASS");
}

main().catch((err) => {
  console.error("[smoke] FAIL", err);
  process.exit(1);
});
