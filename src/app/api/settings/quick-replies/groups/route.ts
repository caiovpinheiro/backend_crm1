import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/quick-replies/groups");

export async function GET() {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; organizationId?: string | null } | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    try {
      const groups = await prisma.quickReplyGroup.findMany({
        where: { organizationId: user.organizationId },
        orderBy: { order: "asc" },
        include: { _count: { select: { quickReplies: true } } },
      });
      return NextResponse.json(groups);
    } catch {
      // Table doesn't exist yet (migration pending) — return empty list.
      return NextResponse.json([]);
    }
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao listar grupos." }, { status: 500 });
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
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });

    const count = await prisma.quickReplyGroup.count({
      where: { organizationId: user.organizationId },
    });

    const group = await prisma.quickReplyGroup.create({
      data: { name, order: count, organizationId: user.organizationId },
      include: { _count: { select: { quickReplies: true } } },
    });
    return NextResponse.json(group, { status: 201 });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao criar grupo." }, { status: 500 });
  }
}
