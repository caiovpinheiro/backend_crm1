import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/favorites");

type Ctx = { params: Promise<{ id: string }> };

export type FavoriteMessageDto = {
  id: string;
  content: string;
  createdAt: string;
  direction: "in" | "out" | "system";
  senderName: string | null;
};

/**
 * GET /api/conversations/:id/favorites
 *
 * Lista as mensagens que o agente LOGADO favoritou nesta conversa —
 * marcador pessoal (`FavoriteMessage.userId`), não compartilhado entre
 * agentes. Alimenta o painel "Mensagens favoritas" no menu (⋮) do chat,
 * igual ao WhatsApp.
 */
export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await ctx.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      const userId = (session.user as { id: string }).id;

      const favorites = await prisma.favoriteMessage.findMany({
        where: { userId, message: { conversationId: id } },
        orderBy: { createdAt: "desc" },
        select: {
          message: {
            select: {
              id: true,
              externalId: true,
              content: true,
              createdAt: true,
              direction: true,
              senderName: true,
            },
          },
        },
      });

      const items: FavoriteMessageDto[] = favorites
        .filter((f) => f.message)
        .map((f) => ({
          id: f.message!.externalId ?? f.message!.id,
          content: f.message!.content,
          createdAt: f.message!.createdAt.toISOString(),
          direction: f.message!.direction as FavoriteMessageDto["direction"],
          senderName: f.message!.senderName ?? null,
        }));

      return NextResponse.json({ items });
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
