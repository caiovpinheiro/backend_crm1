import { NextResponse } from "next/server";

import { sniffImageMime } from "@/lib/file-sniff";
import { getLogger } from "@/lib/logger";
import { readStoredFile } from "@/lib/storage/local";
import { resolveWebchatTheme } from "@/lib/webchat/config";
import { getClientIp, webchatRateLimit } from "@/lib/webchat/http";
import { webchatLogoFileOf } from "@/lib/webchat/logo";
import { loadWebchatChannelByKey, webchatError } from "@/lib/webchat/session";

const log = getLogger("api/public/webchat/logo");

/**
 * GET /api/public/webchat/logo?key=wc_…
 *
 * Público (sem sessão). Devolve a imagem em uso no widget deste canal: a própria
 * ou, sem ela, a da organização. Só aceita a chave pública, então não dá para pedir
 * outro arquivo. Só serve o bucket `branding` da organização do canal, e os bytes
 * precisam ser JPEG, PNG, WEBP ou GIF. Não confere a origem, porque `<img>` não a
 * envia e a chave já é pública. docs/decisoes/webchat-widget.md §9.14.
 */
export async function GET(request: Request) {
  const rl = await webchatRateLimit("GET /api/public/webchat/logo", [
    { profile: "webchat.config", scope: "ip", id: getClientIp(request) },
  ]);
  if (!rl.ok) return rl.response;

  const notFound = () => webchatError(404, "CHANNEL_NOT_FOUND", "Imagem não encontrada.", rl.headers);
  try {
    const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
    const channel = key ? await loadWebchatChannelByKey(key) : null;
    if (!channel) return notFound();

    const { avatarUrl } = resolveWebchatTheme(channel.config.theme, channel.orgDefaults);
    const { fileName } = webchatLogoFileOf(avatarUrl, channel.organizationId);
    if (!fileName) return notFound();

    const file = await readStoredFile(channel.organizationId, "branding", fileName);
    const mimeType = file ? sniffImageMime(file.buffer) : null;
    if (!file || !mimeType) return notFound();

    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        ...rl.headers,
        "Content-Type": mimeType,
        "Content-Length": String(file.buffer.length),
        "Cache-Control": "public, max-age=3600",
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e: unknown) {
    log.error({ err: e }, "GET falhou");
    return notFound();
  }
}
