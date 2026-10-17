import { NextResponse } from "next/server";

import { resolveWebchatTheme } from "@/lib/webchat/config";
import { getClientIp, webchatRateLimit } from "@/lib/webchat/http";
import { isWebchatOnline } from "@/lib/webchat/online";
import {
  checkWebchatOrigin,
  loadWebchatChannelByKey,
  originDenied,
  webchatError,
} from "@/lib/webchat/session";

/**
 * GET /api/public/webchat/config?key=wc_…[&host=https://site-do-cliente]
 *
 * Público (sem sessão). Config do canal achatado na raiz (`publicKey`,
 * `allowedOrigins`, `identification`, `greeting`, `offlineMessage`, `theme`,
 * `businessHours?`, `collectTranscriptEmail`) + `online` + `channel.name`.
 * `theme` vem resolvido: `primary` ← canal ou `Organization.primaryColor`
 * (fallback `#2563EB`); `avatarUrl` ← canal ou `Organization.logoUrl` (ou null).
 * `allowedOrigins` é público de propósito: a página do widget (FE) monta o
 * `frame-ancestors` com ele — não é segredo (qualquer um vê onde o widget
 * está embutido). `host` = origem da página que embute o widget; tem de
 * estar em `allowedOrigins` (vazio = só a página hospedada).
 */
export async function GET(request: Request) {
  const rl = await webchatRateLimit("GET /api/public/webchat/config", [
    { profile: "webchat.config", scope: "ip", id: getClientIp(request) },
  ]);
  if (!rl.ok) return rl.response;

  const url = new URL(request.url);
  const key = url.searchParams.get("key")?.trim() ?? "";
  if (!key) return webchatError(400, "INVALID_KEY", "Parâmetro key ausente.", rl.headers);
  const channel = await loadWebchatChannelByKey(key);
  if (!channel) return webchatError(404, "CHANNEL_NOT_FOUND", "Chat não encontrado.", rl.headers);
  if (!checkWebchatOrigin(request, channel.config, url.searchParams.get("host"))) {
    return originDenied();
  }

  const online = await isWebchatOnline(channel.organizationId, channel.config);
  return NextResponse.json(
    {
      ...channel.config,
      // Tema efetivo: o que o canal não define herda da marca da org.
      theme: resolveWebchatTheme(channel.config.theme, channel.orgDefaults),
      online,
      channel: { name: channel.name },
    },
    { headers: { ...rl.headers, "Cache-Control": "no-store" } },
  );
}
