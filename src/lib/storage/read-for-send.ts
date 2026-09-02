/**
 * Bytes para upload Meta (automação / header de template).
 *
 * O worker-automation não compartilha o disco da API no EasyPanel.
 * GET /api/storage na API acha o arquivo; readStoredFile no worker não.
 * Ordem: driver local/S3 → aliases → legado public/uploads → peer HTTP
 * (STORAGE_PEER_URL / STORAGE_FALLBACK_URL + CRON_SECRET). Hit remoto
 * grava no driver ativo (próximo send não cruza a rede).
 */
import { persistLegacyBytesToActiveDriver } from "@/lib/storage/migrate-from-legacy";
import {
  mimeFromFilename,
  parseStoragePath,
  readLegacyUploadsFile,
  readStoredFile,
  resolveOrgOwnedReuseUrl,
  reuseFileNameAliases,
  type ReadFileResult,
  type StorageBucket,
} from "@/lib/storage/local";
import { readPeerStorageBytes } from "@/lib/storage/upstream-fallback";

export type StoredMediaForSend = ReadFileResult & {
  fileName: string;
  source: "local" | "legacy" | "peer";
};

function parseStoredMediaRef(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return parseStoragePath(new URL(trimmed).pathname);
    } catch {
      return null;
    }
  }
  return parseStoragePath(trimmed);
}

async function readLocalOrAlias(
  orgId: string,
  bucket: StorageBucket,
  fileName: string,
): Promise<ReadFileResult | null> {
  const direct = await readStoredFile(orgId, bucket, fileName);
  if (direct) return direct;
  for (const alias of reuseFileNameAliases(fileName)) {
    if (alias === fileName) continue;
    const hit = await readStoredFile(orgId, bucket, alias);
    if (hit) return hit;
  }
  return null;
}

export async function readStoredMediaForSend(
  mediaUrl: string,
): Promise<StoredMediaForSend | null> {
  const trimmed = mediaUrl.trim();
  if (!trimmed) return null;

  const parsed = parseStoredMediaRef(trimmed);
  if (parsed) {
    const local = await readLocalOrAlias(parsed.orgId, parsed.bucket, parsed.fileName);
    if (local) {
      return { ...local, fileName: parsed.fileName, source: "local" };
    }

    const reuse = resolveOrgOwnedReuseUrl(trimmed, parsed.orgId);
    if (reuse?.legacyRelative) {
      const legacy = await readLegacyUploadsFile(reuse.legacyRelative);
      if (legacy) {
        return { ...legacy, fileName: parsed.fileName, source: "legacy" };
      }
    }

    const names = reuseFileNameAliases(parsed.fileName);
    for (const fileName of names) {
      const peer = await readPeerStorageBytes(
        `${parsed.orgId}/${parsed.bucket}/${fileName}`,
      );
      if (!peer?.length) continue;
      void persistLegacyBytesToActiveDriver(
        { orgId: parsed.orgId, bucket: parsed.bucket, fileName },
        peer,
      ).catch((err) => {
        console.warn("[storage] write-through peer falhou:", err);
      });
      return {
        buffer: peer,
        size: peer.length,
        mimeType: mimeFromFilename(fileName),
        fileName,
        source: "peer",
      };
    }
    return null;
  }

  if (trimmed.startsWith("/uploads/")) {
    const relative = trimmed.slice("/uploads/".length);
    const legacy = await readLegacyUploadsFile(relative);
    if (legacy) {
      return {
        ...legacy,
        fileName: relative.split("/").pop() ?? relative,
        source: "legacy",
      };
    }
  }

  return null;
}

export function isOrgOwnedStorageUrl(mediaUrl: string): boolean {
  const trimmed = mediaUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/uploads/")) return true;
  return parseStoredMediaRef(trimmed) != null;
}
