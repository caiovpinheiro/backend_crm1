import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/quick-replies/[id]");

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; organizationId?: string | null } | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await ctx.params;
    const body = (await request.json()) as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    if (typeof body.title === "string" && body.title.trim()) data.title = body.title.trim();
    if (typeof body.content === "string" && body.content.trim()) data.content = body.content.trim();
    if (typeof body.position === "number") data.position = body.position;
    if ("groupId" in body) data.groupId = body.groupId ?? null;
    if ("attachmentUrl" in body) data.attachmentUrl = body.attachmentUrl ?? null;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    if (data.groupId) {
      const group = await prisma.quickReplyGroup.findFirst({
        where: { id: data.groupId as string, organizationId: user.organizationId },
        select: { id: true },
      });
      if (!group) {
        return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
      }
    }

    const updated = await prisma.quickReply.update({
      where: { id, organizationId: user.organizationId },
      data,
      include: { group: { select: { id: true, name: true } } },
    });
    return NextResponse.json(updated);
  } catch (e) {
    log.error({ err: e }, "PUT falhou");
    return NextResponse.json({ message: "Erro ao atualizar resposta rápida." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; organizationId?: string | null } | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await ctx.params;

    const existing = await prisma.quickReply.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
    }

    await prisma.quickReply.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json({ message: "Erro ao excluir resposta rápida." }, { status: 500 });
  }
}
