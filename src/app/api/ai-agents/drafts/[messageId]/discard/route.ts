import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { publishMessageDeleted } from "@/lib/realtime-events";

/**
 * Descarta um rascunho da IA. Hard-delete: a mensagem some do
 * histórico do operador. Se o usuário quiser reter decisões, basta
 * não descartar (rascunho fica visível com status "draft" até ser
 * aprovado ou expirar manualmente).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withOrgContext(async () => {
    const { messageId } = await params;

    const draft = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        messageType: true,
        isPrivate: true,
        conversationId: true,
        organizationId: true,
      },
    });
    if (!draft || draft.messageType !== "ai_draft" || !draft.isPrivate) {
      return NextResponse.json(
        { message: "Rascunho não encontrado." },
        { status: 404 },
      );
    }
    await prisma.message.delete({ where: { id: messageId } });
    publishMessageDeleted({
      organizationId: draft.organizationId,
      conversationId: draft.conversationId,
      messageId,
    });
    return NextResponse.json({ ok: true });
  });
}
