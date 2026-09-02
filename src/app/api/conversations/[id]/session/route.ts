import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getContactChannelSession, getConversationSession } from "@/lib/channel-session";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { getConversationLite } from "@/services/conversations";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/conversations/:id/session?channelId=X
 *
 * Janela de 24h da Meta para o par (contato da conversa, canal X). Usada
 * pelo composer do inbox ao trocar o canal de envio: o `session` do GET
 * messages reflete só o canal DA CONVERSA, então sem este endpoint o
 * composer não sabe que o contato não tem sessão aberta no canal de
 * destino (texto livre passava e falhava na Meta com 131047).
 *
 * Canal não-Meta (ex.: BAILEYS_MD) não tem janela → active: true.
 * Sem `channelId` → sessão da própria conversa (mesmo cálculo do GET
 * messages).
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      const denied = await requireConversationAccess({ user: authResult.user }, id);
      if (denied) return denied;

      const conv = await getConversationLite(id);
      if (!conv) {
        return NextResponse.json(
          { message: "Conversa não encontrada." },
          { status: 404 },
        );
      }

      const channelId =
        new URL(request.url).searchParams.get("channelId")?.trim() || null;

      // Sem channelId: sessão da própria conversa (espelha o GET messages).
      if (!channelId || channelId === conv.channelId) {
        const session = await getConversationSession(conv);
        return NextResponse.json({
          active: session.active,
          lastInboundAt: session.lastInboundAt?.toISOString() ?? null,
          expiresAt: session.expiresAt?.toISOString() ?? null,
        });
      }

      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true, organizationId: true, provider: true },
      });
      if (!channel || channel.organizationId !== conv.organizationId) {
        return NextResponse.json(
          { message: "Canal informado não pertence à organização." },
          { status: 400 },
        );
      }

      // Baileys (e demais não-Meta) não têm janela de 24h.
      if (channel.provider !== "META_CLOUD_API") {
        return NextResponse.json({
          active: true,
          lastInboundAt: null,
          expiresAt: null,
        });
      }

      if (!conv.contactId) {
        return NextResponse.json({
          active: false,
          lastInboundAt: null,
          expiresAt: null,
        });
      }

      const session = await getContactChannelSession(conv.contactId, channel.id);
      return NextResponse.json({
        active: session.active,
        lastInboundAt: session.lastInboundAt?.toISOString() ?? null,
        expiresAt: session.expiresAt?.toISOString() ?? null,
      });
    });
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao consultar sessão.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
