import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { createNode, getTree } from "@/services/tabulations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/tabulations");

/**
 * GET /api/settings/tabulations?departmentId=xxx
 * → arvore hierarquica (roots com children[] aninhados) do departamento.
 * POST /api/settings/tabulations
 *   body: { departmentId, parentId?, name, color? }
 * → cria um no na arvore.
 *
 * Role: ADMIN ou MANAGER (padrao settings). Callers agentes usam
 * /api/tabulations (rota separada, sem role check).
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const url = new URL(request.url);
    const departmentId = url.searchParams.get("departmentId")?.trim();
    if (!departmentId) {
      return NextResponse.json(
        { message: "departmentId eh obrigatorio." },
        { status: 400 },
      );
    }
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Organização não definida na sessão." },
        { status: 400 },
      );
    }
    const dept = await prisma.department.findFirst({
      where: { id: departmentId, organizationId: orgId },
      select: {
        id: true,
        requireTabulationOnClose: true,
        autoCloseTabulationId: true,
      },
    });
    if (!dept) {
      return NextResponse.json(
        { message: "Departamento nao encontrado." },
        { status: 404 },
      );
    }
    const tree = await getTree(departmentId);
    return NextResponse.json({
      departmentId,
      requireTabulationOnClose: dept.requireTabulationOnClose,
      autoCloseTabulationId: dept.autoCloseTabulationId,
      tree,
    });
  });
}

const CreateSchema = z.object({
  departmentId: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(120),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados invalidos." }, { status: 400 });
    }
    try {
      const created = await createNode({
        departmentId: parsed.data.departmentId,
        parentId: parsed.data.parentId ?? null,
        name: parsed.data.name,
        color: parsed.data.color ?? null,
      });
      return NextResponse.json(created, { status: 201 });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "PARENT_INVALID") {
        return NextResponse.json({ message: "Pai invalido.", code }, { status: 400 });
      }
      log.error({ err: e }, "[tabulations][POST] falhou");
      return NextResponse.json(
        { message: "Erro ao criar tabulacao." },
        { status: 500 },
      );
    }
  });
}
