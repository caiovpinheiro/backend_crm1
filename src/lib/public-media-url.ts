import { createHmac, timingSafeEqual } from "node:crypto";

import { isValidFileName, isValidOrgId, parseStoragePath } from "@/lib/storage/local";

/**
 * Link público de um arquivo que o contato mandou (foto ou PDF).
 * O caminho `/api/storage/...` exige sessão. O n8n baixa pelo mesmo
 * caminho com `?t=`, sem cookie. O token só abre esse arquivo.
 */
const PUBLIC_MEDIA_BUCKETS = new Set(["inbound-media"]);

export type PublicMediaRef = {
  orgId: string;
  bucket: string;
  fileName: string;
};

function signingSecret(): string {
  return (process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "").trim();
}

function publicBase(): string {
  return (
    process.env.BACKEND_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

function signPayload(payload: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function storageRefFromText(value: string): PublicMediaRef | null {
  const marker = "/api/storage/";
  const idx = value.indexOf(marker);
  if (idx < 0) return null;
  const rest = value.slice(idx + marker.length).split(/[?#\s"\\]/)[0] ?? "";
  const parsed = parseStoragePath(rest);
  if (!parsed || !PUBLIC_MEDIA_BUCKETS.has(parsed.bucket)) return null;
  if (!isValidOrgId(parsed.orgId) || !isValidFileName(parsed.fileName)) return null;
  return { orgId: parsed.orgId, bucket: parsed.bucket, fileName: parsed.fileName };
}

export function signPublicMediaToken(ref: PublicMediaRef): string | null {
  if (!PUBLIC_MEDIA_BUCKETS.has(ref.bucket)) return null;
  if (!isValidOrgId(ref.orgId) || !isValidFileName(ref.fileName)) return null;
  const payload = Buffer.from(
    JSON.stringify({ o: ref.orgId, b: ref.bucket, f: ref.fileName }),
  ).toString("base64url");
  const sig = signPayload(payload);
  if (!sig) return null;
  return `${payload}.${sig}`;
}

export function verifyPublicMediaToken(token: string): PublicMediaRef | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payload);
  if (!expected) return null;
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      o?: unknown;
      b?: unknown;
      f?: unknown;
    };
    if (typeof json.o !== "string" || typeof json.b !== "string" || typeof json.f !== "string") {
      return null;
    }
    if (!PUBLIC_MEDIA_BUCKETS.has(json.b)) return null;
    if (!isValidOrgId(json.o) || !isValidFileName(json.f)) return null;
    return { orgId: json.o, bucket: json.b, fileName: json.f };
  } catch {
    return null;
  }
}

export function publicMediaTokenMatches(token: string, ref: PublicMediaRef): boolean {
  const parsed = verifyPublicMediaToken(token);
  if (!parsed) return false;
  return (
    parsed.orgId === ref.orgId &&
    parsed.bucket === ref.bucket &&
    parsed.fileName === ref.fileName
  );
}

/** URL absoluta que o n8n consegue baixar. Sem segredo, devolve o caminho original. */
export function toPublicMediaUrl(value: string): string | null {
  const ref = storageRefFromText(value);
  if (!ref) return null;
  const token = signPublicMediaToken(ref);
  if (!token) return null;
  const path = `/api/storage/${ref.orgId}/${ref.bucket}/${encodeURIComponent(ref.fileName)}?t=${encodeURIComponent(token)}`;
  const base = publicBase();
  return base ? `${base}${path}` : path;
}

/** Troca cada caminho de mídia recebida pela URL pública. O resto do texto fica. */
export function rewriteStorageUrlsForWebhook(text: string): string {
  return text.replace(
    /(?:https?:\/\/[^/\s"\\]+)?\/api\/storage\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9._~%-]+(?:\?[^\s"\\]*)?/g,
    (match) => toPublicMediaUrl(match) ?? match,
  );
}
