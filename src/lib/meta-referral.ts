import { extForMime, sniffImageMime } from "@/lib/file-sniff";
import { getLogger } from "@/lib/logger";
import { readResponseBodyLimited } from "@/lib/media-byte-limits";
import { assertSafeOutboundUrl } from "@/lib/safe-outbound-url";
import { generateFileName, saveFile } from "@/lib/storage/local";

const log = getLogger("meta-referral");

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_MS = 12_000;

export type ReferralInfo = {
  sourceId: string | null;
  sourceType: string | null;
  ctwaClid: string | null;
  headline: string | null;
  body: string | null;
  sourceUrl: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
};

export type MessageReferral = {
  sourceId?: string;
  sourceType?: string;
  ctwaClid?: string;
  headline?: string;
  body?: string;
  sourceUrl?: string;
  mediaType?: string;
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  storedImageUrl?: string;
  storedThumbnailUrl?: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Referral de anúncio no webhook (`messages[].referral`), não a mídia da mensagem. */
export function parseReferral(message: Record<string, unknown>): ReferralInfo | null {
  const ref = obj(message.referral);
  if (Object.keys(ref).length === 0) return null;
  return {
    sourceId: str(ref.source_id) || null,
    sourceType: str(ref.source_type) || null,
    ctwaClid: str(ref.ctwa_clid) || null,
    headline: str(ref.headline) || null,
    body: str(ref.body) || null,
    sourceUrl: str(ref.source_url) || null,
    mediaType: str(ref.media_type) || null,
    imageUrl: str(ref.image_url) || null,
    videoUrl: str(ref.video_url) || null,
    thumbnailUrl: str(ref.thumbnail_url) || null,
  };
}

const REFERRAL_KEYS = [
  "sourceId",
  "sourceType",
  "ctwaClid",
  "headline",
  "body",
  "sourceUrl",
  "mediaType",
  "imageUrl",
  "videoUrl",
  "thumbnailUrl",
  "storedImageUrl",
  "storedThumbnailUrl",
] as const satisfies readonly (keyof MessageReferral)[];

/** JSON vindo do banco — só as chaves conhecidas, sem HTML e sem lixo. */
export function referralFromJson(raw: unknown): MessageReferral | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: MessageReferral = {};
  for (const key of REFERRAL_KEYS) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function compactReferral(
  ref: ReferralInfo,
  stored: { storedImageUrl?: string | null; storedThumbnailUrl?: string | null } = {},
): MessageReferral | null {
  const out: MessageReferral = {};
  const put = (key: keyof MessageReferral, value: string | null | undefined) => {
    const v = value?.trim();
    if (v) out[key] = v;
  };
  put("sourceId", ref.sourceId);
  put("sourceType", ref.sourceType);
  put("ctwaClid", ref.ctwaClid);
  put("headline", ref.headline);
  put("body", ref.body);
  put("sourceUrl", ref.sourceUrl);
  put("mediaType", ref.mediaType);
  put("imageUrl", ref.imageUrl);
  put("videoUrl", ref.videoUrl);
  put("thumbnailUrl", ref.thumbnailUrl);
  put("storedImageUrl", stored.storedImageUrl);
  put("storedThumbnailUrl", stored.storedThumbnailUrl);
  return Object.keys(out).length > 0 ? out : null;
}

async function copyImage(orgId: string, rawUrl: string): Promise<string | null> {
  const url = rawUrl.trim();
  if (!url.startsWith("https://")) return null;
  try {
    await assertSafeOutboundUrl(url);
  } catch {
    log.warn({ organizationId: orgId }, "[meta-referral] creative media unavailable, preserving original referral");
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ac.signal,
      redirect: "error",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BwipoCRM/1.0)" },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;

  let buf: Buffer;
  try {
    buf = await readResponseBodyLimited(res, MAX_BYTES);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  const mime = sniffImageMime(buf);
  if (!mime) return null;

  const saved = await saveFile({
    orgId,
    bucket: "inbound-media",
    fileName: generateFileName({ prefix: "referral", ext: extForMime(mime) }),
    buffer: buf,
  });
  return saved.url;
}

/**
 * Copia o criativo para o storage da org. Falha de rede, URL ou storage
 * devolve o referral sem `stored*` — a mensagem segue.
 */
export async function buildMessageReferral(
  orgId: string,
  ref: ReferralInfo,
): Promise<MessageReferral | null> {
  log.info(
    { organizationId: orgId, sourceId: ref.sourceId },
    "[meta-referral] referral detected",
  );
  let storedImageUrl: string | null = null;
  let storedThumbnailUrl: string | null = null;
  try {
    const primary = ref.imageUrl || ref.thumbnailUrl;
    if (primary) {
      const stored = await copyImage(orgId, primary);
      if (stored) {
        if (ref.imageUrl) storedImageUrl = stored;
        else storedThumbnailUrl = stored;
        log.info(
          { organizationId: orgId, sourceId: ref.sourceId },
          "[meta-referral] creative media persisted",
        );
      } else {
        log.info(
          { organizationId: orgId, sourceId: ref.sourceId },
          "[meta-referral] creative media unavailable, preserving original referral",
        );
      }
    }
  } catch (err) {
    log.warn(
      { organizationId: orgId, sourceId: ref.sourceId, err },
      "[meta-referral] creative media unavailable, preserving original referral",
    );
  }
  return compactReferral(ref, { storedImageUrl, storedThumbnailUrl });
}
