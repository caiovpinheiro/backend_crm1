import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import {
  cancelScheduledMessage,
  getScheduledMessage,
} from "@/services/scheduled-messages";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/scheduled-messages/[id]");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/scheduled-messages/:id
 * Cancelamento manual. Só quem passa em `requireConversationAccess`
 * na conversa do agendamento. Outra org ou sem visibilidade: 404
 * (não enumera a conversa).
 */
export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const uid = session.user.id;

      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const existing = await getScheduledMessage(id);
      if (!existing) {
        return NextResponse.json(
          { message: "Agendamento não encontrado." },
          { status: 404 },
        );
      }

      const denied = await requireConversationAccess(session, existing.conversationId);
      if (denied) return denied;

      const updated = await cancelScheduledMessage(id, uid);
      return NextResponse.json(updated);
    } catch (e) {
      log.error({ err: e }, "DELETE /api/scheduled-messages/:id error");
      return NextResponse.json(
        { message: "Erro ao cancelar agendamento." },
        { status: 500 },
      );
    }
  });
}
