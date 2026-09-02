#!/usr/bin/env node
/**
 * Copia /app/storage (volume Docker) → DigitalOcean Spaces.
 *
 * Roda na imagem standalone (sem scripts TS). No container do 187:
 *
 *   export S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
 *   export S3_BUCKET=media-crmm-ny3-do
 *   export S3_ACCESS_KEY=...
 *   export S3_SECRET=...
 *   export STORAGE_ROOT=/app/storage
 *   DRY_RUN=1 node /tmp/migrate-disk-to-spaces.mjs
 *   node /tmp/migrate-disk-to-spaces.mjs
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const BUCKETS = new Set([
  "attachments",
  "recordings",
  "automation-media",
  "avatars",
  "contact-avatars",
  "inbound-media",
  "branding",
  "data-exports",
  "imports",
]);

const dryRun = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const root = (process.env.STORAGE_ROOT ?? "/app/storage").replace(/\/$/, "");
const endpoint = (process.env.S3_ENDPOINT ?? "").replace(/\/$/, "");
const bucket = process.env.S3_BUCKET ?? "";
const accessKey = process.env.S3_ACCESS_KEY ?? "";
const secret = process.env.S3_SECRET ?? "";
const region = process.env.S3_REGION ?? "us-east-1";

if (!endpoint || !bucket || !accessKey || !secret) {
  console.error("Faltam S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY ou S3_SECRET.");
  process.exit(1);
}

const host = new URL(endpoint).host;

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function amzDate(d = new Date()) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signHeaders({ method, key, payloadHash, extra = {} }) {
  const now = new Date();
  const amz = amzDate(now);
  const datestamp = amz.slice(0, 8);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...extra,
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signed.join(";");
  const canonical = [
    method,
    `/${bucket}/${key}`,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    sha256Hex(canonical),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secret}`, datestamp), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function s3(method, key, body, contentType) {
  const payloadHash = body
    ? sha256Hex(body)
    : "UNSIGNED-PAYLOAD";
  const extra = {};
  if (method === "PUT" && contentType) extra["content-type"] = contentType;
  if (method === "PUT" && body) extra["content-length"] = String(body.length);
  if (!body && method !== "PUT") extra["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
  const headers = signHeaders({
    method,
    key,
    payloadHash: body ? payloadHash : "UNSIGNED-PAYLOAD",
    extra: body ? extra : { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
  });
  const url = `${endpoint}/${bucket}/${key}`;
  const res = await fetch(url, { method, headers, body: body ?? undefined });
  if (res.status === 404) return { ok: false, status: 404 };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${key} → ${res.status} ${text.slice(0, 200)}`);
  }
  return { ok: true, status: res.status };
}

function mimeOf(fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

async function walk() {
  const keys = [];
  let orgs;
  try {
    orgs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    console.error(`STORAGE_ROOT inacessível (${root}):`, err.message);
    process.exit(1);
  }
  for (const orgDir of orgs) {
    if (!orgDir.isDirectory() || orgDir.name.startsWith(".")) continue;
    for (const bucketName of BUCKETS) {
      const dir = path.join(root, orgDir.name, bucketName);
      let files;
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const fileName of files) {
        if (!fileName || fileName.startsWith(".")) continue;
        const abs = path.join(dir, fileName);
        const st = await stat(abs).catch(() => null);
        if (!st?.isFile()) continue;
        keys.push({
          abs,
          key: `${orgDir.name}/${bucketName}/${fileName}`,
          size: st.size,
          mime: mimeOf(fileName),
        });
      }
    }
  }
  return keys;
}

async function readAll(abs) {
  const chunks = [];
  for await (const c of createReadStream(abs)) chunks.push(c);
  return Buffer.concat(chunks);
}

const files = await walk();
const result = { scanned: files.length, already: 0, copied: 0, errors: 0 };
console.log(
  JSON.stringify({
    mode: dryRun ? "dry-run" : "apply",
    root,
    endpoint,
    bucket,
    scanned: files.length,
  }),
);

let i = 0;
for (const file of files) {
  i += 1;
  try {
    const head = await s3("HEAD", file.key);
    if (head.ok) {
      result.already += 1;
    } else if (dryRun) {
      result.copied += 1;
    } else {
      const body = await readAll(file.abs);
      await s3("PUT", file.key, body, file.mime);
      result.copied += 1;
    }
  } catch (err) {
    result.errors += 1;
    console.warn(`ERR ${file.key}: ${err instanceof Error ? err.message : err}`);
  }
  if (i % 50 === 0 || i === files.length) {
    console.log(`[migrate] ${i}/${files.length} ${file.key}`);
  }
}

console.log(JSON.stringify(result, null, 2));
if (result.errors > 0) process.exit(2);
