/**
 * Grupos de WhatsApp vinculados à empresa — seletor do passo de automação
 * "Enviar para empresa".
 *   GET → { items: [{ id, name, connected }] }
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { listCompanyGroupOptions } from "@/services/company-group-send";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    const items = await listCompanyGroupOptions(id);
    return NextResponse.json({ items });
  });
}
