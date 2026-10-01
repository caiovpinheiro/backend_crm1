import { extForMime, sniffImageMime } from "@/lib/file-sniff";
import { prisma } from "@/lib/prisma";
import { assertSafeOutboundUrl } from "@/lib/safe-outbound-url";
import { readResponseBodyLimited } from "@/lib/media-byte-limits";

import { generateFileName, saveFile, type OrgOwnedReuseUrl } from "./local";

const MAX_BYTES = 16 * 1024 * 1024;
const FETCH_MS = 15_000;

/**
 * Capa de produto fora do storage (ex.: i.ibb.co) não passa em
 * resolveOrgOwnedReuseUrl. Se a URL é exatamente Product.imageUrl desta
 * org, baixa, grava em automation-media e atualiza o catálogo.
 */
export async function ingestProductCoverForReuse(
  orgId: string,
  rawUrl: string,
): Promise<OrgOwnedReuseUrl | null> {
  const reuseUrl = rawUrl.trim();
  if (!reuseUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(reuseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  try {
    await assertSafeOutboundUrl(reuseUrl);
  } catch {
    return null;
  }

  const owned = await prisma.product.findFirst({
    where: { organizationId: orgId, imageUrl: reuseUrl },
    select: { id: true },
  });
  if (!owned) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  let res: Response;
  try {
    res = await fetch(reuseUrl, {
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

  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return null;

  let buf: Buffer;
  try {
    buf = await readResponseBodyLimited(res, MAX_BYTES);
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;

  const mime = sniffImageMime(buf);
  if (!mime) return null;

  const ext = extForMime(mime);
  const fileName = generateFileName({ prefix: "product", ext });
  const saved = await saveFile({
    orgId,
    bucket: "automation-media",
    fileName,
    buffer: buf,
  });

  const pathName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
  const imageName = (pathName || fileName).slice(0, 180);

  await prisma.product.updateMany({
    where: { organizationId: orgId, imageUrl: reuseUrl },
    data: { imageUrl: saved.url, imageMime: mime, imageName },
  });

  return {
    url: saved.url,
    orgId,
    bucket: "automation-media",
    fileName,
  };
}
