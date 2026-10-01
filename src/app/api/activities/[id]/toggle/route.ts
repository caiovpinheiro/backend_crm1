import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getActivityById, toggleActivityComplete } from "@/services/activities";
import { canAccessActivity } from "@/services/task-visibility";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/activities/[id]/toggle");

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const existing = await getActivityById(id);
    if (!existing) {
      return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
    }
    const su = session.user as {
      id: string;
      role?: string | null;
      organizationId?: string | null;
      isSuperAdmin?: boolean;
    };
    if (
      !(await canAccessActivity(
        {
          id: su.id,
          organizationId: su.organizationId ?? null,
          role: su.role ?? null,
          isSuperAdmin: Boolean(su.isSuperAdmin),
        },
        existing,
      ))
    ) {
      return NextResponse.json(
        { message: "Sem permissão para concluir esta tarefa." },
        { status: 403 },
      );
    }

    try {
      const activity = await toggleActivityComplete(id);
      return NextResponse.json(activity);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
      }
      throw err;
    }
  } catch (e: unknown) {
    log.error({ err: e }, "POST falhou");
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Atividade não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao alternar conclusão da atividade." }, { status: 500 });
  }
}
