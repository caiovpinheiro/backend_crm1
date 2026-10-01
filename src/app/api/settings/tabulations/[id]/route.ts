import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { deleteNode, updateNode } from "@/services/tabulations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/tabulations/[id]");

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  parentId: z.string().min(1).nullable().optional(),
  position: z.number().int().optional(),
  active: z.boolean().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const { id } = await ctx.params;
    const body = await request.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados invalidos." }, { status: 400 });
    }
    try {
      const updated = await updateNode(id, parsed.data);
      return NextResponse.json(updated);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") {
        return NextResponse.json({ message: "Nao encontrada." }, { status: 404 });
      }
      if (code === "PARENT_INVALID" || code === "CYCLE") {
        return NextResponse.json({ message: (e as Error).message, code }, { status: 400 });
      }
      log.error({ err: e }, "[tabulations][PUT] falhou");
      return NextResponse.json(
        { message: "Erro ao atualizar tabulacao." },
        { status: 500 },
      );
    }
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const { id } = await ctx.params;
    try {
      await deleteNode(id);
      return NextResponse.json({ ok: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") {
        return NextResponse.json({ message: "Nao encontrada." }, { status: 404 });
      }
      log.error({ err: e }, "[tabulations][DELETE] falhou");
      return NextResponse.json(
        { message: "Erro ao remover tabulacao." },
        { status: 500 },
      );
    }
  });
}
