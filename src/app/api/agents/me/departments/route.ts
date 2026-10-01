import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Departamentos de que o usuário logado é membro (`DepartmentMember`).
 *
 * O alerta do inbox no cliente usa isto para decidir "fila minha": ticket
 * sem responsável num destes departamentos gera toast (sem som). Não é o
 * escopo de visibilidade — quem enxerga tudo continua só com os próprios
 * departamentos aqui.
 */
export async function GET() {
  return withOrgContext(async (session) => {
    const organizationId = session.user.organizationId;
    if (!organizationId) return NextResponse.json({ departmentIds: [] });
    const rows = await prisma.departmentMember.findMany({
      where: { userId: session.user.id, organizationId },
      select: { departmentId: true },
    });
    return NextResponse.json({
      departmentIds: rows.map((r) => r.departmentId),
    });
  });
}
