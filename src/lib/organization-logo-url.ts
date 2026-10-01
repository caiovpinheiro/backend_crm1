import { parseStoragePath } from "@/lib/storage/local";

/**
 * Novos valores de Organization.logoUrl. Uploads passam por
 * POST /api/organization/logo (magic bytes, sem SVG). Este helper fecha o
 * PATCH /api/onboarding/branding, que antes gravava qualquer string.
 *
 * O valor já persistido (`currentLogoUrl`) é reaceito sem revalidar —
 * não apaga logos legítimos (incluindo data URLs antigos).
 */

const ACTIVE_CONTENT_PATH = /\.(svgz?|html?|xhtml|xml|js|mjs)(?:$|[/?#])/i;
const BRANDING_RASTER_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

export const UNSAFE_LOGO_URL_MESSAGE =
  "URL do logo inválida. Envie JPG, PNG, WEBP ou GIF pelo upload ou use um link https de imagem.";

function storagePathFromInput(raw: string): string {
  if (raw.startsWith("/api/storage/")) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.pathname.startsWith("/api/storage/")) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    /* não é URL absoluta */
  }
  return raw;
}

export function normalizeOrganizationLogoUrl(
  input: string | null | undefined,
  opts: { organizationId: string; currentLogoUrl?: string | null },
): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const current = opts.currentLogoUrl?.trim() || null;
  if (current && trimmed === current) return current;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:")
  ) {
    throw new Error(UNSAFE_LOGO_URL_MESSAGE);
  }

  const stored = parseStoragePath(storagePathFromInput(trimmed));
  if (stored) {
    if (stored.orgId !== opts.organizationId || stored.bucket !== "branding") {
      throw new Error(UNSAFE_LOGO_URL_MESSAGE);
    }
    if (!BRANDING_RASTER_EXT.test(stored.fileName)) {
      throw new Error(UNSAFE_LOGO_URL_MESSAGE);
    }
    return trimmed.startsWith("/api/storage/")
      ? trimmed.split(/[?#]/)[0]!
      : `/api/storage/${stored.orgId}/branding/${encodeURIComponent(stored.fileName)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(UNSAFE_LOGO_URL_MESSAGE);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(UNSAFE_LOGO_URL_MESSAGE);
  }
  if (parsed.username || parsed.password || !parsed.hostname) {
    throw new Error(UNSAFE_LOGO_URL_MESSAGE);
  }
  if (ACTIVE_CONTENT_PATH.test(parsed.pathname)) {
    throw new Error(UNSAFE_LOGO_URL_MESSAGE);
  }
  return trimmed;
}
