import { parseStoragePath } from "@/lib/storage/local";

/** Extrai `?url=` de `/api/media/proxy?url=...` (path relativo ou absoluto). */
export function extractMediaProxyTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = trimmed.startsWith("/")
      ? new URL(trimmed, "http://media.invalid")
      : new URL(trimmed);
    if (!u.pathname.includes("/api/media/proxy")) return null;
    const target = u.searchParams.get("url");
    return target?.trim() || null;
  } catch {
    return null;
  }
}

export type ClassifiedMediaUrl =
  | { kind: "meta"; url: string }
  | { kind: "storage"; orgId: string; bucket: string; fileName: string }
  | { kind: "uploads"; relative: string }
  | { kind: "denied" };

/**
 * Classifica a URL que o FE manda para transcribe/mp3/proxy.
 * Recusa esquemas e hosts que não são storage interno ou CDN Meta.
 */
export function classifyMediaUrl(raw: string): ClassifiedMediaUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "denied" };

  const proxyTarget = extractMediaProxyTarget(trimmed);
  if (proxyTarget) {
    return { kind: "meta", url: proxyTarget };
  }

  const stored = parseStoragePath(trimmed);
  if (stored) {
    return {
      kind: "storage",
      orgId: stored.orgId,
      bucket: stored.bucket,
      fileName: stored.fileName,
    };
  }

  let pathAndSearch = trimmed;
  try {
    if (!trimmed.startsWith("/")) {
      const u = new URL(trimmed);
      pathAndSearch = `${u.pathname}${u.search}`;
    }
  } catch {
    return { kind: "denied" };
  }

  const storedFromPath = parseStoragePath(pathAndSearch);
  if (storedFromPath) {
    return {
      kind: "storage",
      orgId: storedFromPath.orgId,
      bucket: storedFromPath.bucket,
      fileName: storedFromPath.fileName,
    };
  }

  if (pathAndSearch.startsWith("/uploads/")) {
    return { kind: "uploads", relative: pathAndSearch.slice("/uploads/".length) };
  }
  if (pathAndSearch.startsWith("/api/uploads/")) {
    return {
      kind: "uploads",
      relative: pathAndSearch.slice("/api/uploads/".length),
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "meta", url: trimmed };
  }

  return { kind: "denied" };
}
