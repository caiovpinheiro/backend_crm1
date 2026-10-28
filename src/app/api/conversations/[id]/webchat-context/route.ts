import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { CONVERSATION_ACCESS_SELECT, requireConversationAccessAndLoad } from "@/lib/conversation-access";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { loadWebchatSitePanel } from "@/lib/webchat/tracking/panel";

const log = getLogger("api/conversations/[id]/webchat-context");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/conversations/:id/webchat-context
 *
 * Painel "No site agora" (docs/decisoes/webchat-widget.md §9.3): o último
 * estado que o site mandou (`setContext`) para o contato no canal da
 * conversa, os eventos mais recentes (`track`) e os rótulos das chaves da
 * config do canal. Mesmo acesso da conversa (org, canal, departamento,
 * funil); 404 sem acesso. Conversa fora do webchat → `{ available: false }`.
 *
 * 200 `{ available, contactId, channelId, labels, context: { state, updatedAt } | null,
 *        events: { id, name, data, important, occurredAt }[] }`.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      const loaded = await requireConversationAccessAndLoad(
        { user: authResult.user },
        id,
        (where) =>
          prisma.conversation.findFirst({
            where,
            select: { ...CONVERSATION_ACCESS_SELECT, channel: true },
          }),
      );
      if (loaded.response) return loaded.response;
      const panel = await loadWebchatSitePanel(loaded.conversation);
      return NextResponse.json(panel, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (e) {
    log.error({ err: e }, "[webchat-context] erro");
    return NextResponse.json({ message: "Erro ao carregar o contexto do site." }, { status: 500 });
  }
}
