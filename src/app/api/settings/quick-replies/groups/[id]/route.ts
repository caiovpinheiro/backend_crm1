import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/quick-replies/groups/[id]");

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
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.order === "number") data.order = body.order;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    const updated = await prisma.quickReplyGroup.update({
      where: { id, organizationId: user.organizationId },
      data,
      include: { _count: { select: { quickReplies: true } } },
    });
    return NextResponse.json(updated);
  } catch (e) {
    log.error({ err: e }, "PUT falhou");
    return NextResponse.json({ message: "Erro ao atualizar grupo." }, { status: 500 });
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
    await prisma.quickReplyGroup.delete({
      where: { id, organizationId: user.organizationId },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json({ message: "Erro ao excluir grupo." }, { status: 500 });
  }
}
