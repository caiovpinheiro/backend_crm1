/**
 * Copia mídia do host legado (disco /app/storage ou STORAGE_FALLBACK_URL)
 * para o driver ativo (Spaces). Depois do lote, remova a env e desligue
 * o `187` / banco-backend-crm.
 */
import { readdir, readFile } from "fs/promises";
import path from "path";

import { prismaBase } from "@/lib/prisma-base";
import {
  BUCKETS,
  existsStoredFile,
  parseStoragePath,
  resolveOrgOwnedReuseUrl,
  resolveStoragePath,
  saveFile,
  storageRoot,
  type StorageBucket,
} from "@/lib/storage/local";
import { readUpstreamFallbackBytes } from "@/lib/storage/upstream-fallback";

export type MigrateStorageKey = {
  orgId: string;
  bucket: StorageBucket;
  fileName: string;
};

export type MigrateStorageResult = {
  scanned: number;
  already: number;
  copied: number;
  missing: number;
  errors: number;
  missingKeys: string[];
  errorKeys: string[];
};

export type MigrateStorageOptions = {
  orgId?: string;
  dryRun?: boolean;
  /** Disco em STORAGE_ROOT (rode no container que ainda tem o volume 187). */
  fromDisk?: boolean;
  /** GET no STORAGE_FALLBACK_URL para chaves referenciadas no banco. */
  fromFallback?: boolean;
  cookieHeader?: string | null;
  concurrency?: number;
  onProgress?: (done: number, total: number, last: string) => void;
};

function keyLabel(k: MigrateStorageKey): string {
  return `${k.orgId}/${k.bucket}/${k.fileName}`;
}

function addKey(map: Map<string, MigrateStorageKey>, key: MigrateStorageKey) {
  map.set(keyLabel(key), key);
}

function parseReferencedUrl(
  raw: string | null | undefined,
  orgId: string,
): MigrateStorageKey | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  const asPath = parseStoragePath(
    trimmed.startsWith("http")
      ? (() => {
          try {
            return new URL(trimmed).pathname;
          } catch {
            return trimmed;
          }
        })()
      : trimmed,
  );
  if (asPath && (!orgId || asPath.orgId === orgId)) {
    return { orgId: asPath.orgId, bucket: asPath.bucket, fileName: asPath.fileName };
  }
  const reuse = resolveOrgOwnedReuseUrl(trimmed, orgId);
  if (reuse) {
    return { orgId: reuse.orgId, bucket: reuse.bucket, fileName: reuse.fileName };
  }
  return null;
}

async function listDiskKeys(orgFilter?: string): Promise<MigrateStorageKey[]> {
  const root = storageRoot();
  const out: MigrateStorageKey[] = [];
  let orgEntries: { name: string; isDirectory: () => boolean }[];
  try {
    orgEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const orgDir of orgEntries) {
    if (!orgDir.isDirectory()) continue;
    if (orgFilter && orgDir.name !== orgFilter) continue;
    for (const bucket of BUCKETS) {
      const dir = path.join(root, orgDir.name, bucket);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const fileName of files) {
        if (!fileName || fileName.startsWith(".")) continue;
        out.push({ orgId: orgDir.name, bucket, fileName });
      }
    }
  }
  return out;
}

async function listDbKeys(orgFilter?: string): Promise<MigrateStorageKey[]> {
  const map = new Map<string, MigrateStorageKey>();
  const orgWhere = orgFilter ? { organizationId: orgFilter } : {};

  const take = 2_000;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prismaBase.message.findMany({
      where: { ...orgWhere, mediaUrl: { not: null } },
      select: { id: true, organizationId: true, mediaUrl: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const row of rows) {
      const key = parseReferencedUrl(row.mediaUrl, row.organizationId);
      if (key) addKey(map, key);
    }
    if (rows.length < take) break;
    cursor = rows[rows.length - 1]!.id;
  }

  const templates = await prismaBase.messageTemplate.findMany({
    where: orgWhere,
    select: { organizationId: true, mediaUrl: true, attachments: true },
  });
  for (const row of templates) {
    const urls = [row.mediaUrl];
    if (Array.isArray(row.attachments)) {
      for (const item of row.attachments) {
        if (item && typeof item === "object" && "url" in item) {
          urls.push(typeof item.url === "string" ? item.url : null);
        }
      }
    }
    for (const url of urls) {
      const key = parseReferencedUrl(url, row.organizationId);
      if (key) addKey(map, key);
    }
  }

  const extras: Array<{ organizationId: string; url: string | null }> = [];
  const [replies, users, contacts, orgs, calls, scheduled, docs] =
    await Promise.all([
      prismaBase.quickReply.findMany({
        where: { ...orgWhere, attachmentUrl: { not: null } },
        select: { organizationId: true, attachmentUrl: true },
      }),
      prismaBase.user.findMany({
        where: { ...orgWhere, avatarUrl: { not: null } },
        select: { organizationId: true, avatarUrl: true },
      }),
      prismaBase.contact.findMany({
        where: { ...orgWhere, avatarUrl: { not: null } },
        select: { organizationId: true, avatarUrl: true },
      }),
      prismaBase.organization.findMany({
        where: orgFilter ? { id: orgFilter } : {},
        select: { id: true, logoUrl: true },
      }),
      prismaBase.call.findMany({
        where: { ...orgWhere, recordingUrl: { not: null } },
        select: { organizationId: true, recordingUrl: true },
      }),
      prismaBase.scheduledMessage.findMany({
        where: { ...orgWhere, mediaUrl: { not: null } },
        select: { organizationId: true, mediaUrl: true },
      }),
      prismaBase.aIAgentKnowledgeDoc.findMany({
        where: { ...orgWhere, storageUrl: { not: null } },
        select: { organizationId: true, storageUrl: true },
      }),
    ]);

  for (const row of replies) extras.push({ organizationId: row.organizationId, url: row.attachmentUrl });
  for (const row of users) extras.push({ organizationId: row.organizationId, url: row.avatarUrl });
  for (const row of contacts) extras.push({ organizationId: row.organizationId, url: row.avatarUrl });
  for (const row of orgs) extras.push({ organizationId: row.id, url: row.logoUrl });
  for (const row of calls) extras.push({ organizationId: row.organizationId, url: row.recordingUrl });
  for (const row of scheduled) extras.push({ organizationId: row.organizationId, url: row.mediaUrl });
  for (const row of docs) extras.push({ organizationId: row.organizationId, url: row.storageUrl });

  for (const row of extras) {
    const key = parseReferencedUrl(row.url, row.organizationId);
    if (key) addKey(map, key);
  }

  return [...map.values()];
}

async function readDiskBytes(key: MigrateStorageKey): Promise<Buffer | null> {
  try {
    const abs = resolveStoragePath(key.orgId, key.bucket, key.fileName);
    const buf = await readFile(abs);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

async function recoverBytes(
  key: MigrateStorageKey,
  opts: { fromDisk?: boolean; fromFallback?: boolean; cookieHeader?: string | null },
): Promise<Buffer | null> {
  if (opts.fromDisk) {
    const disk = await readDiskBytes(key);
    if (disk) return disk;
  }
  if (opts.fromFallback) {
    const joined = `${key.orgId}/${key.bucket}/${key.fileName}`;
    const remote = await readUpstreamFallbackBytes(joined, opts.cookieHeader ?? null, {
      timeoutMs: 30_000,
    });
    if (remote?.length) return remote;
  }
  return null;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/** Copia um objeto já lido do fallback para o driver ativo (GET write-through). */
export async function persistLegacyBytesToActiveDriver(
  key: MigrateStorageKey,
  buffer: Buffer,
): Promise<void> {
  if (!buffer.length) return;
  const already = await existsStoredFile(key.orgId, key.bucket, key.fileName);
  if (already) return;
  await saveFile({
    orgId: key.orgId,
    bucket: key.bucket,
    fileName: key.fileName,
    buffer,
  });
}

export async function migrateStorageFromLegacy(
  opts: MigrateStorageOptions,
): Promise<MigrateStorageResult> {
  const fromDisk = opts.fromDisk !== false;
  const fromFallback = opts.fromFallback !== false;
  const keys = new Map<string, MigrateStorageKey>();
  if (fromDisk) {
    for (const key of await listDiskKeys(opts.orgId)) addKey(keys, key);
  }
  if (fromFallback || !fromDisk) {
    for (const key of await listDbKeys(opts.orgId)) addKey(keys, key);
  }
  const list = [...keys.values()];
  const result: MigrateStorageResult = {
    scanned: list.length,
    already: 0,
    copied: 0,
    missing: 0,
    errors: 0,
    missingKeys: [],
    errorKeys: [],
  };
  let done = 0;
  await mapPool(list, opts.concurrency ?? 6, async (key) => {
    const label = keyLabel(key);
    try {
      if (await existsStoredFile(key.orgId, key.bucket, key.fileName)) {
        result.already += 1;
      } else {
        const bytes = await recoverBytes(key, {
          fromDisk,
          fromFallback,
          cookieHeader: opts.cookieHeader,
        });
        if (!bytes) {
          result.missing += 1;
          if (result.missingKeys.length < 80) result.missingKeys.push(label);
        } else if (opts.dryRun) {
          result.copied += 1;
        } else {
          await saveFile({
            orgId: key.orgId,
            bucket: key.bucket,
            fileName: key.fileName,
            buffer: bytes,
          });
          result.copied += 1;
        }
      }
    } catch (err) {
      result.errors += 1;
      if (result.errorKeys.length < 40) {
        result.errorKeys.push(
          `${label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    done += 1;
    opts.onProgress?.(done, list.length, label);
  });
  return result;
}
