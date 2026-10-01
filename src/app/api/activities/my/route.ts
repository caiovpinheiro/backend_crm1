import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/activities/my");

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const url = new URL(request.url);
    const completed = url.searchParams.get("completed");

    const where: Prisma.ActivityWhereInput = {
      userId: session.user.id,
      type: "TASK",
    };
    if (completed === "true") where.completed = true;
    if (completed === "false") where.completed = false;

    const tasks = await prisma.activity.findMany({
      where,
      orderBy: [{ completed: "asc" }, { scheduledAt: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: {
        deal: { select: { id: true, title: true } },
        contact: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(tasks);
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao listar tarefas." }, { status: 500 });
  }
}
