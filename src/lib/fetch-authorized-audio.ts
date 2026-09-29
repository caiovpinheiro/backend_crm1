import { readFile } from "fs/promises";
import path from "path";

import { classifyMediaUrl } from "@/lib/classify-media-url";
import { resolveLegacyUploadOrgId } from "@/lib/legacy-upload-org";
import {
  MEDIA_PROCESS_MAX_BYTES,
  MediaTooLargeError,
  readResponseBodyLimited,
} from "@/lib/media-byte-limits";
import { resolveMetaMediaAccess } from "@/lib/meta-media-access";
import { isAllowedMetaMediaUrl } from "@/lib/meta-media-url";
import { mimeFromFilename, readStoredFile } from "@/lib/storage/local";
import { authorizeStorageObject } from "@/lib/storage-object-access";

export { MediaTooLargeError };

export async function fetchAuthorizedAudioBuffer(
  rawUrl: string,
  session: {
    userId: string;
    organizationId: string;
    isSuperAdmin?: boolean;
    role?: string | null;
  },
): Promise<{ buffer: Buffer; contentType: string }> {
  const classified = classifyMediaUrl(rawUrl);

  if (classified.kind === "meta") {
    if (!isAllowedMetaMediaUrl(classified.url)) {
      throw new Error("URL não autorizada.");
    }
    const access = await resolveMetaMediaAccess(session.organizationId, classified.url);
    if (!access) throw new Error("Arquivo não encontrado.");
    const res = await fetch(classified.url, {
      headers: { Authorization: `Bearer ${access.token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Meta retornou ${res.status}.`);
    }
    const buffer = await readResponseBodyLimited(res, MEDIA_PROCESS_MAX_BYTES);
    return {
      buffer,
      contentType: res.headers.get("content-type") || "audio/ogg",
    };
  }

  if (classified.kind === "storage") {
    const ok = await authorizeStorageObject(session, classified);
    if (!ok) throw new Error("Arquivo não encontrado.");
    const stored = await readStoredFile(
      classified.orgId,
      classified.bucket,
      classified.fileName,
    );
    if (!stored) throw new Error("Arquivo não encontrado.");
    if (stored.buffer.length > MEDIA_PROCESS_MAX_BYTES) {
      throw new MediaTooLargeError(MEDIA_PROCESS_MAX_BYTES);
    }
    return { buffer: stored.buffer, contentType: stored.mimeType };
  }

  if (classified.kind === "uploads") {
    const ownerOrg = await resolveLegacyUploadOrgId(classified.relative.split("?")[0] ?? "");
    if (!session.isSuperAdmin && ownerOrg !== session.organizationId) {
      throw new Error("Arquivo não encontrado.");
    }
    if (!ownerOrg) throw new Error("Arquivo não encontrado.");
    const relative = classified.relative.replace(/\.\./g, "").split("?")[0] ?? "";
    const abs = path.join(process.cwd(), "public", "uploads", relative);
    const buffer = await readFile(abs);
    if (buffer.length > MEDIA_PROCESS_MAX_BYTES) {
      throw new MediaTooLargeError(MEDIA_PROCESS_MAX_BYTES);
    }
    return {
      buffer,
      contentType: mimeFromFilename(path.basename(abs)),
    };
  }

  throw new Error("URL não autorizada.");
}
