import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  getTree,
  getTreesForDepartments,
  listDepartmentsForUser,
} from "@/services/tabulations";

/**
 * Rota de leitura para agentes (nao exige role ADMIN/MANAGER — soh
 * autenticacao). Usada pelo modal de tabulacao no encerramento.
 *
 * GET /api/tabulations?departmentId=xxx
 *   → arvore do departamento da conversa
 * GET /api/tabulations?userId=xxx
 *   → arvores de todos os departamentos em que o agente eh membro,
 *     agrupadas por departamento (conversa sem departmentId)
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const url = new URL(request.url);
    const departmentId = url.searchParams.get("departmentId")?.trim() || null;
    const userId = url.searchParams.get("userId")?.trim() || null;
    if (!departmentId && !userId) {
      return NextResponse.json(
        { message: "departmentId ou userId eh obrigatorio." },
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

    if (departmentId) {
      const dept = await prisma.department.findFirst({
        where: { id: departmentId, organizationId: orgId },
        select: { id: true, name: true, requireTabulationOnClose: true },
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
        userId: null,
        requireTabulationOnClose: dept.requireTabulationOnClose,
        tree,
        groups: [
          {
            departmentId: dept.id,
            departmentName: dept.name,
            requireTabulationOnClose: dept.requireTabulationOnClose,
            tree,
          },
        ],
      });
    }

    const departments = await listDepartmentsForUser(userId!);
    const groups = await getTreesForDepartments(departments);
    const requireTabulationOnClose = groups.some(
      (g) => g.requireTabulationOnClose,
    );
    return NextResponse.json({
      departmentId: null,
      userId,
      requireTabulationOnClose,
      tree: groups.length === 1 ? groups[0]!.tree : [],
      groups,
    });
  });
}
