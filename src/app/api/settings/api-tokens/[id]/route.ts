import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/authz";
import { revokeToken } from "@/services/api-tokens";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/api-tokens/[id]");

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    const user = session?.user as
      | { id?: string; organizationId?: string | null; isSuperAdmin?: boolean }
      | undefined;
    if (!user?.id || !user.organizationId) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    // SEC-18: mesma permissão de criar/listar.
    const denied = await requirePermission(
      { id: user.id, organizationId: user.organizationId, isSuperAdmin: Boolean(user.isSuperAdmin) },
      "api_token:manage",
    );
    if (denied) return denied;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    await revokeToken(id, user.id, user.organizationId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error({ err: e }, "DELETE falhou");
    return NextResponse.json({ message: "Erro ao revogar token." }, { status: 500 });
  }
}
