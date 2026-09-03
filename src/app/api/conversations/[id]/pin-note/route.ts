import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;
    const denied = await requireConversationAccess(session, id);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const noteId: string | null = body.noteId ?? null;

    if (noteId) {
      const msg = await prisma.message.findFirst({
        where: { id: noteId, conversationId: id, isPrivate: true },
      });
      if (!msg) {
        return NextResponse.json(
          { message: "Nota não encontrada nesta conversa." },
          { status: 404 },
        );
      }
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: { pinnedNoteId: noteId },
      select: { id: true, pinnedNoteId: true },
    });

    return NextResponse.json(updated);
  });
}
