import { extForMime, sniffImageMime } from "@/lib/file-sniff";
import { prisma } from "@/lib/prisma";

import { generateFileName, saveFile, type OrgOwnedReuseUrl } from "./local";

const MAX_BYTES = 16 * 1024 * 1024;
const FETCH_MS = 15_000;

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".local")) {
    return true;
  }
  if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(h)) {
    return true;
  }
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) {
      return true;
    }
  }
  return false;
}

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
  if (isBlockedHostname(parsed.hostname)) return null;

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
      redirect: "follow",
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

  const buf = Buffer.from(await res.arrayBuffer());
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
