import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { logEvent } from "@/services/activity-log";

type Ctx = { params: Promise<{ id: string }> };

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      const notes = await prisma.note.findMany({
        where: { contactId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: { select: { id: true, name: true } } },
      });
      return NextResponse.json(notes);
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
    }
  });
}

export async function POST(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id: contactId } = await ctx.params;
      const body = (await request.json()) as Record<string, unknown>;
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) return NextResponse.json({ message: "Conteúdo obrigatório." }, { status: 400 });

      const dealId = typeof body.dealId === "string" ? body.dealId.trim() : undefined;

      const note = await prisma.note.create({
        data: withOrgFromCtx({
          content,
          contactId,
          dealId: dealId || undefined,
          userId: session.user.id as string,
        }),
        include: { user: { select: { id: true, name: true } } },
      });

      // Activity Log: sempre loga NOTE_ADDED, independente de ter
      // dealId. O composer do contact-panel nao envia dealId no body,
      // entao o branch antigo `if (dealId)` deixava nota orfa sem log.
      // entityType segue o sujeito principal: DEAL quando vinculada,
      // CONTACT caso contrario — feed filtra por entidade corretamente.
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { name: true, phone: true, email: true },
      });
      void logEvent({
        type: "NOTE_ADDED",
      actorType: "HUMAN",
        entityType: dealId ? "DEAL" : "CONTACT",
        entityId: dealId || contactId,
        entityLabel: contact?.name ?? contact?.phone ?? contact?.email ?? null,
        contactId,
        dealId: dealId || null,
        meta: {
          noteId: note.id,
          preview: content.slice(0, 200),
          source: dealId ? "deal_workspace" : "contact_panel",
        },
      });

      return NextResponse.json(note, { status: 201 });
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
    }
  });
}
