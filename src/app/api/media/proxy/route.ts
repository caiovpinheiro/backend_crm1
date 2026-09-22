import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  MEDIA_PROXY_MAX_BYTES,
  MediaTooLargeError,
  contentLengthExceeds,
  limitReadableStream,
} from "@/lib/media-byte-limits";
import { resolveMetaMediaAccess } from "@/lib/meta-media-access";
import { isAllowedMetaMediaUrl } from "@/lib/meta-media-url";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const orgId = (session.user as { organizationId?: string | null }).organizationId ?? null;
  if (!orgId) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const mediaUrl = searchParams.get("url");
  if (!mediaUrl || !isAllowedMetaMediaUrl(mediaUrl)) {
    return NextResponse.json({ message: "URL inválida." }, { status: 400 });
  }

  const access = await resolveMetaMediaAccess(orgId, mediaUrl);
  if (!access) {
    return NextResponse.json({ message: "Arquivo não encontrado." }, { status: 404 });
  }

  try {
    const upstreamHeaders: Record<string, string> = {
      Authorization: `Bearer ${access.token}`,
    };
    const range = request.headers.get("range");
    if (range) upstreamHeaders["Range"] = range;

    const res = await fetch(mediaUrl, {
      headers: upstreamHeaders,
      cache: "no-store",
      redirect: "error",
    });

    if (!res.ok && res.status !== 206) {
      return NextResponse.json(
        { message: `Meta retornou ${res.status}. A mídia pode ter expirado.` },
        { status: 502 },
      );
    }

    if (contentLengthExceeds(res, MEDIA_PROXY_MAX_BYTES)) {
      return NextResponse.json(
        { message: new MediaTooLargeError(MEDIA_PROXY_MAX_BYTES).message },
        { status: 413 },
      );
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const outHeaders = new Headers({
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    });

    const contentRange = res.headers.get("content-range");
    if (contentRange) outHeaders.set("Content-Range", contentRange);
    const contentLength = res.headers.get("content-length");
    if (contentLength) outHeaders.set("Content-Length", contentLength);

    const body = res.body
      ? limitReadableStream(res.body, MEDIA_PROXY_MAX_BYTES)
      : null;

    return new Response(body, {
      status: res.status,
      headers: outHeaders,
    });
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      return NextResponse.json({ message: err.message }, { status: 413 });
    }
    console.error("[media-proxy] Error:", err);
    return NextResponse.json({ message: "Erro ao buscar mídia." }, { status: 502 });
  }
}
