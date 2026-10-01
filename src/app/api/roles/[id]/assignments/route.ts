import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { addRoleAssignment } from "@/services/roles";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/roles/[id]/assignments");

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  userId: z.string().min(1),
});

export async function POST(request: Request, context: RouteContext) {
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

    const { id: roleId } = await context.params;
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const role = await addRoleAssignment(roleId, parsed.data.userId);
      if (!role) {
        return NextResponse.json({ message: "Role não encontrado." }, { status: 404 });
      }
      return NextResponse.json(role, { status: 201 });
    } catch (e) {
      log.error({ err: e }, "[POST /api/roles/[id]/assignments]");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao atribuir role." },
        { status: 400 },
      );
    }
  });
}
