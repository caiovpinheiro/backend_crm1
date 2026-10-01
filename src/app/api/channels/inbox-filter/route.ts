import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { listAllowedChannelIds } from "@/lib/authz/resource-policy";
import { getChannelsForInboxFilter } from "@/services/channels";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/inbox-filter");

/**
 * GET /api/channels/inbox-filter
 *
 * Instâncias de canal da org para o dropdown CANAL do inbox — inclui
 * desconectados/falhos e canais já excluídos que ainda aparecem em
 * conversas. Não substitui GET /api/channels (settings/composer).
 */
export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const [channels, allowed] = await Promise.all([
        getChannelsForInboxFilter(),
        listAllowedChannelIds({
          id: session.user.id,
          role: session.user.role ?? "MEMBER",
          organizationId: session.user.organizationId,
        }),
      ]);
      if (!allowed) {
        return NextResponse.json({ channels });
      }
      const allowedSet = new Set(allowed);
      return NextResponse.json({
        channels: channels.filter((c) => allowedSet.has(c.id)),
      });
    } catch (e: unknown) {
      log.error({ err: e }, "GET falhou");
      const msg = e instanceof Error ? e.message : "Erro ao listar canais.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
