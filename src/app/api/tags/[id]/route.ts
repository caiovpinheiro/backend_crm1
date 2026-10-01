import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import type { AppUserRole } from "@/lib/auth-types";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/tags/[id]");

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ message: "Não autorizado." }, { status: 401 });

    const role = (session.user as { role?: AppUserRole }).role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json({ message: "Sem permissão para editar tags." }, { status: 403 });
    }

    const { id } = await ctx.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ message: "JSON inválido." }, { status: 400 });

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.color === "string" && body.color.trim()) data.color = body.color.trim();

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    const tag = await prisma.tag.update({ where: { id }, data });
    return NextResponse.json(tag);
  } catch (e: unknown) {
    log.error({ err: e }, "PUT falhou");
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json({ message: "Já existe uma tag com este nome." }, { status: 409 });
    }
    return NextResponse.json({ message: "Erro ao atualizar tag." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ message: "Não autorizado." }, { status: 401 });

    const role = (session.user as { role?: AppUserRole }).role;
    if (role !== "ADMIN") {
      return NextResponse.json({ message: "Apenas administradores podem excluir tags." }, { status: 403 });
    }

    const { id } = await ctx.params;
    await prisma.tag.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json({ message: "Erro ao excluir tag." }, { status: 500 });
  }
}
