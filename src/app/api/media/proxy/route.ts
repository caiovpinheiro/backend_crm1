import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
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

  // A URL Meta só é servida se pertencer à org da sessão (mensagem ou
  // avatar). Token do canal da conversa; fallback env da plataforma.
  const access = await resolveMetaMediaAccess(orgId, mediaUrl);
  if (!access) {
    return NextResponse.json({ message: "Arquivo não encontrado." }, { status: 404 });
  }

  try {
    // Repassa o Range do cliente ao upstream. O <video> do Chrome exige
    // resposta 206 (Partial Content) para tocar/buscar — sem isso o player
    // fica preto em 0:00. Meta/WhatsApp CDN suporta range requests.
    const upstreamHeaders: Record<string, string> = {
      Authorization: `Bearer ${access.token}`,
    };
    const range = request.headers.get("range");
    if (range) upstreamHeaders["Range"] = range;

    const res = await fetch(mediaUrl, {
      headers: upstreamHeaders,
      cache: "no-store",
      // Sem seguir redirect: o token da org não pode vazar para outro host.
      redirect: "error",
    });

    // 200 (completo) e 206 (parcial) são ambos válidos.
    if (!res.ok && res.status !== 206) {
      return NextResponse.json(
        { message: `Meta retornou ${res.status}. A mídia pode ter expirado.` },
        { status: 502 }
      );
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const outHeaders = new Headers({
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      // Mídia autorizada por org/sessão: não pode ficar em cache compartilhado.
      "Cache-Control": "private, no-store",
    });

    // Preserva headers de range/tamanho do upstream para o player.
    const contentRange = res.headers.get("content-range");
    if (contentRange) outHeaders.set("Content-Range", contentRange);
    const contentLength = res.headers.get("content-length");
    if (contentLength) outHeaders.set("Content-Length", contentLength);

    // PR 1.3: removido cache lateral em public/uploads (vazava mídia
    // entre orgs). Streaming direto do body para o cliente — evita
    // carregar o vídeo inteiro em memória.
    return new Response(res.body, {
      status: res.status,
      headers: outHeaders,
    });
  } catch (err) {
    console.error("[media-proxy] Error:", err);
    return NextResponse.json({ message: "Erro ao buscar mídia." }, { status: 502 });
  }
}
