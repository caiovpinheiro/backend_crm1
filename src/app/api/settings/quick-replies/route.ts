import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/quick-replies");

export async function GET(request: Request) {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; organizationId?: string | null } | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const groupIdParam = searchParams.get("groupId");
    const q = searchParams.get("q");

    const where: Record<string, unknown> = { organizationId: user.organizationId };

    if (groupIdParam === "ungrouped") {
      where.groupId = null;
    } else if (groupIdParam) {
      where.groupId = groupIdParam;
    }

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { content: { contains: q, mode: "insensitive" } },
      ];
    }

    try {
      const replies = await prisma.quickReply.findMany({
        where,
        orderBy: { position: "asc" },
        include: { group: { select: { id: true, name: true } } },
      });
      return NextResponse.json(replies);
    } catch {
      // group relation may not exist yet (migration pending) — try without include.
      const replies = await prisma.quickReply.findMany({
        where: { organizationId: user.organizationId },
        orderBy: { position: "asc" },
      });
      return NextResponse.json(replies.map((r) => ({ ...r, group: null })));
    }
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao listar respostas rápidas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; organizationId?: string | null } | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!title) return NextResponse.json({ message: "Título é obrigatório." }, { status: 400 });
    if (!content) return NextResponse.json({ message: "Conteúdo é obrigatório." }, { status: 400 });

    const groupId = typeof body.groupId === "string" && body.groupId ? body.groupId : null;
    const attachmentUrl =
      typeof body.attachmentUrl === "string" && body.attachmentUrl ? body.attachmentUrl : null;

    if (groupId) {
      const group = await prisma.quickReplyGroup.findFirst({
        where: { id: groupId, organizationId: user.organizationId },
        select: { id: true },
      });
      if (!group) {
        return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
      }
    }

    const position = await prisma.quickReply.count({
      where: { organizationId: user.organizationId, groupId },
    });

    const reply = await prisma.quickReply.create({
      data: {
        title,
        content,
        groupId,
        attachmentUrl,
        position,
        organizationId: user.organizationId,
        createdByUserId: user.id,
      },
      include: { group: { select: { id: true, name: true } } },
    });
    return NextResponse.json(reply, { status: 201 });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao criar resposta rápida." }, { status: 500 });
  }
}
