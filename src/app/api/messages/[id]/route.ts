import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

const MAX_NOTE_LENGTH = 4000;

/**
 * Só notas internas (`isPrivate`) podem ser editadas/excluídas: mensagem
 * pública já foi entregue ao cliente pelo canal e não tem "desfazer".
 */
async function findEditableNote(id: string) {
  return prisma.message.findFirst({
    where: { id, isPrivate: true },
    select: { id: true, conversationId: true },
  });
}

/** PATCH /api/messages/:id — edita o texto de uma nota interna. */
export async function PATCH(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;

    const note = await findEditableNote(id);
    if (!note) {
      return NextResponse.json({ message: "Nota não encontrada." }, { status: 404 });
    }
    const gate = await requireConversationAccess(session, note.conversationId);
    if (gate) return gate;

    const body = await request.json().catch(() => ({}));
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) {
      return NextResponse.json({ message: "Informe o texto da nota." }, { status: 400 });
    }
    if (content.length > MAX_NOTE_LENGTH) {
      return NextResponse.json(
        { message: `A nota pode ter no máximo ${MAX_NOTE_LENGTH} caracteres.` },
        { status: 400 },
      );
    }

    const updated = await prisma.message.update({
      where: { id: note.id },
      data: { content },
      select: { id: true, content: true, conversationId: true },
    });
    return NextResponse.json(updated);
  });
}

/** DELETE /api/messages/:id — exclui uma nota interna (desafixa se preciso). */
export async function DELETE(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;

    const note = await findEditableNote(id);
    if (!note) {
      return NextResponse.json({ message: "Nota não encontrada." }, { status: 404 });
    }
    const gate = await requireConversationAccess(session, note.conversationId);
    if (gate) return gate;

    await prisma.$transaction(async (tx) => {
      await tx.conversation.updateMany({
        where: { id: note.conversationId, pinnedNoteId: note.id },
        data: { pinnedNoteId: null },
      });
      // FavoriteMessage / PinnedMessage caem por cascade.
      await tx.message.delete({ where: { id: note.id } });
    });

    return NextResponse.json({ id: note.id, conversationId: note.conversationId });
  });
}
