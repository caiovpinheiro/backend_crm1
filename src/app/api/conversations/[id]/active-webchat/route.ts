import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import type { AppUserRole } from "@/lib/auth-types";
import {
  CONVERSATION_ACCESS_SELECT,
  requireConversationAccessAndLoad,
  userHasConversationAccess,
} from "@/lib/conversation-access";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { createRequestMemo } from "@/lib/request-memo";
import { findActiveWebchatConversationForContact } from "@/lib/webchat/active-conversation";

const log = getLogger("api/conversations/[id]/active-webchat");

type RouteContext = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET /api/conversations/:id/active-webchat
 *
 * Ticket webchat em que o contato desta conversa está agora, para o inbox avisar
 * antes de o agente responder pelo canal errado (docs/decisoes/webchat-widget.md
 * §9.13). Mesmo acesso da conversa (404 sem acesso). Ticket que o usuário não pode
 * abrir não é informado. Conversa de webchat ou sem contato → `{ active: null }`.
 *
 * 200 `{ active: { id, number, reason: "online" | "recent_message" } | null }`.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      const accessUser = { ...authResult.user, role: authResult.user.role as AppUserRole };
      const memo = createRequestMemo();
      const loaded = await requireConversationAccessAndLoad(
        { user: authResult.user },
        id,
        (where) =>
          prisma.conversation.findFirst({
            where,
            select: { ...CONVERSATION_ACCESS_SELECT, channel: true },
          }),
        { memo },
      );
      if (loaded.response) return loaded.response;
      const conv = loaded.conversation;
      if (conv.channel === "webchat" || !conv.contactId) {
        return NextResponse.json({ active: null }, { headers: NO_STORE });
      }

      const active = await findActiveWebchatConversationForContact({
        organizationId: conv.organizationId,
        contactId: conv.contactId,
        canOpen: (conversationId) =>
          userHasConversationAccess(accessUser, conversationId, { memo }),
      });
      return NextResponse.json({ active }, { headers: NO_STORE });
    });
  } catch (e) {
    log.error({ err: e }, "[active-webchat] erro");
    return NextResponse.json({ message: "Erro ao consultar o chat do contato." }, { status: 500 });
  }
}
