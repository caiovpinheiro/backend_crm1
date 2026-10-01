import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/messages/[id]/favorite");

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/messages/:id/favorite
 *
 * Favoritar/desfavoritar mensagem — marcador PESSOAL do agente logado
 * (cada agente tem sua própria lista, isolada por `userId`). Aceita
 * internal id OU externalId (wamid), igual `/messages/:id/reactions`.
 *
 * Body opcional `{ favorite: boolean }`. Omitido = toggle automático.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id: ref } = await ctx.params;
      const userId = (session.user as { id: string }).id;

      const message = await prisma.message.findFirst({
        where: { OR: [{ id: ref }, { externalId: ref }] },
        select: { id: true, conversationId: true },
      });
      if (!message) {
        return NextResponse.json(
          { message: "Mensagem não encontrada." },
          { status: 404 },
        );
      }

      const gate = await requireConversationAccess(session, message.conversationId);
      if (gate) return gate;

      const body = await request.json().catch(() => ({}));
      const requested: boolean | undefined =
        typeof body?.favorite === "boolean" ? body.favorite : undefined;

      const existing = await prisma.favoriteMessage.findUnique({
        where: { userId_messageId: { userId, messageId: message.id } },
      });

      // Sem `favorite` explícito no body, alterna o estado atual — é o
      // que o menu contextual da bolha faz (não sabe o estado prévio
      // sem round-trip extra).
      const nextFavorited = requested ?? !existing;

      if (nextFavorited && !existing) {
        await prisma.favoriteMessage.create({
          data: withOrgFromCtx({ userId, messageId: message.id }),
        });
      } else if (!nextFavorited && existing) {
        await prisma.favoriteMessage.delete({ where: { id: existing.id } });
      }

      return NextResponse.json({ favorited: nextFavorited });
    } catch (e) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
