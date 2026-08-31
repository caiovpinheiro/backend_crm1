/**
 * Fallback HTTP para GET /api/storage e reuse de modelo.
 *
 * Quando o objeto não está no Spaces/disco, o gateway tenta
 * STORAGE_FALLBACK_URL (backend legado com o arquivo em /app/storage).
 * Reuse precisa do mesmo read — senão GET 200 e POST reuseUrl 404.
 */

function getFallbackBase(): string | null {
  const raw = process.env.STORAGE_FALLBACK_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

function extractSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const NAMES = [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
  ];
  for (const name of NAMES) {
    const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}=([^;]+)`);
    const m = cookieHeader.match(re);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

function buildUpstreamHeaders(
  cookieHeader: string,
  range: string | null,
): Record<string, string> | null {
  const base = getFallbackBase();
  if (!base) return null;
  const sessionToken = extractSessionToken(cookieHeader);
  if (!sessionToken) {
    const cookieNames = cookieHeader
      ? cookieHeader.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean)
      : [];
    console.warn(
      `[storage] upstream fallback sem sessao: cookies recebidos=[${cookieNames.join(",")}]`,
    );
    return null;
  }
  const variants = [
    `__Secure-authjs.session-token=${encodeURIComponent(sessionToken)}`,
    `authjs.session-token=${encodeURIComponent(sessionToken)}`,
    `__Secure-next-auth.session-token=${encodeURIComponent(sessionToken)}`,
    `next-auth.session-token=${encodeURIComponent(sessionToken)}`,
  ];
  const headers: Record<string, string> = {
    cookie: [cookieHeader, ...variants].filter(Boolean).join("; "),
    host: new URL(base).host,
  };
  if (range) headers.range = range;
  return headers;
}

export async function tryUpstreamFallback(
  request: Request,
  joined: string,
): Promise<Response | null> {
  const base = getFallbackBase();
  if (!base) return null;

  const headers = buildUpstreamHeaders(
    request.headers.get("cookie") ?? "",
    request.headers.get("range"),
  );
  if (!headers) return null;

  const upstreamUrl = `${base}/api/storage/${joined}`;
  try {
    const upstream = await fetch(upstreamUrl, {
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(700),
    });
    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => "(no body)");
      console.warn(
        `[storage] upstream fallback ${upstream.status} para ${joined}: ${errBody.slice(0, 200)}`,
      );
      return null;
    }
    const out = new Headers();
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "last-modified",
      "etag",
    ]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    if (!out.has("content-type")) out.set("content-type", "application/octet-stream");
    if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
    out.set("Cache-Control", "private, max-age=300");
    out.set("X-Storage-Source", "upstream-fallback");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    console.warn("[storage] upstream fallback erro:", err);
    return null;
  }
}

/** Buffer do mesmo upstream (imagens de modelo — sem Range). */
export async function readUpstreamFallbackBytes(
  joined: string,
  cookieHeader: string | null,
): Promise<Buffer | null> {
  const base = getFallbackBase();
  if (!base) return null;
  const headers = buildUpstreamHeaders(cookieHeader ?? "", null);
  if (!headers) return null;
  try {
    const upstream = await fetch(`${base}/api/storage/${joined}`, {
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(700),
    });
    if (!upstream.ok) return null;
    const buf = Buffer.from(await upstream.arrayBuffer());
    return buf.length ? buf : null;
  } catch (err) {
    console.warn("[storage] upstream fallback bytes erro:", err);
    return null;
  }
}
