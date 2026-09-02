const { readFile, stat } = require("fs/promises");
const path = require("path");
const { Client } = require("/tmp/node_modules/pg");
const { S3Client, PutObjectCommand } = require("/tmp/node_modules/@aws-sdk/client-s3");

const root = process.env.STORAGE_ROOT || "/app/storage";
const Bucket = process.env.S3_BUCKET;
if (!process.env.S3_ENDPOINT || !Bucket || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET) {
  console.error("S3_* ausente");
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET,
  },
});

function parseUrl(raw, orgId) {
  if (!raw || typeof raw !== "string") return null;
  let p = raw.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    return null;
  }
  const m = p.match(/^\/api\/storage\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (m) return { orgId: m[1], bucket: m[2], fileName: decodeURIComponent(m[3]) };
  const u = p.match(/^\/uploads\/(?:([^/]+)\/)?([^/]+)$/);
  if (u) {
    return {
      orgId,
      bucket: u[1] || "automation-media",
      fileName: decodeURIComponent(u[2]),
    };
  }
  return null;
}

function mimeOf(f) {
  const e = (f.split(".").pop() || "").toLowerCase();
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      pdf: "application/pdf",
    }[e] || "application/octet-stream"
  );
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL ausente");
    process.exit(1);
  }
  const pg = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pg.connect();
  const { rows } = await pg.query(
    'select "organizationId", "mediaUrl", attachments from message_templates',
  );
  await pg.end();

  const keys = new Map();
  for (const row of rows) {
    const urls = [];
    if (row.mediaUrl) urls.push(row.mediaUrl);
    const atts = Array.isArray(row.attachments) ? row.attachments : [];
    for (const a of atts) if (a && a.url) urls.push(a.url);
    for (const url of urls) {
      const parsed = parseUrl(url, row.organizationId);
      if (parsed) keys.set(`${parsed.orgId}/${parsed.bucket}/${parsed.fileName}`, parsed);
    }
  }

  const r = {
    mode: "put-only",
    templates: rows.length,
    unique: keys.size,
    copied: 0,
    missingDisk: 0,
    errors: 0,
  };
  console.log(JSON.stringify({ start: r }));

  for (const parsed of keys.values()) {
    const Key = `${parsed.orgId}/${parsed.bucket}/${parsed.fileName}`;
    const abs = path.join(root, parsed.orgId, parsed.bucket, parsed.fileName);
    const onDisk = await stat(abs)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!onDisk) {
      r.missingDisk += 1;
      console.warn("MISS", Key);
      continue;
    }
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: await readFile(abs),
          ContentType: mimeOf(parsed.fileName),
        }),
      );
      r.copied += 1;
      console.log("OK", Key);
    } catch (err) {
      r.errors += 1;
      const code = err.$metadata && err.$metadata.httpStatusCode;
      console.warn("PUT", Key, err.name, code, String(err.message).slice(0, 160));
    }
  }

  console.log(JSON.stringify(r, null, 2));
  if (r.errors) process.exit(2);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
