import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { isMetaGraphError } from "@/lib/meta-whatsapp/client";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";
import { getFlowDefinitionById, publishFlowDefinition } from "@/services/whatsapp-flow-definitions";

function requireAdminOrManager(session: { user?: { role?: string } }): NextResponse | null {
  const r = session.user?.role;
  if (r !== "ADMIN" && r !== "MANAGER") {
    return NextResponse.json({ message: "Apenas administrador ou gestor." }, { status: 403 });
  }
  return null;
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = requireAdminOrManager(session);
    if (denied) return denied;
    const { id } = await context.params;
    if (!id) return NextResponse.json({ message: "ID inválido." }, { status: 400 });

    const resolved = await resolveMetaTemplatesClient({
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!resolved.ok) return resolved.response;

    try {
      const flow = await getFlowDefinitionById(id);
      if (!flow) return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
      const out = await publishFlowDefinition(flow.id, resolved.client);
      return NextResponse.json(out, { status: 200 });
    } catch (e: unknown) {
      const extra = e as Error & { validationErrors?: unknown[] };
      const validationErrors = extra.validationErrors ?? [];
      const message = isMetaGraphError(e)
        ? e.toPersistedString()
        : e instanceof Error
          ? e.message
          : "Erro ao publicar na Meta.";
      return NextResponse.json(
        {
          message,
          validationErrors,
        },
        { status: 502 },
      );
    }
  });
}
