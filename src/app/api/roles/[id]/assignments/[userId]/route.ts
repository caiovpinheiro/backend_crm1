import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { removeRoleAssignment } from "@/services/roles";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/roles/[id]/assignments/[userId]");

type RouteContext = { params: Promise<{ id: string; userId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "settings:permissions")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "settings:permissions" },
        { status: 403 },
      );
    }

    const { id: roleId, userId } = await context.params;
    try {
      const result = await removeRoleAssignment(roleId, userId);
      if (!result) {
        return NextResponse.json({ message: "Atribuição não encontrada." }, { status: 404 });
      }
      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "[DELETE /api/roles/[id]/assignments/[userId]]");
      return NextResponse.json(
        { message: "Erro ao remover atribuição." },
        { status: 500 },
      );
    }
  });
}
