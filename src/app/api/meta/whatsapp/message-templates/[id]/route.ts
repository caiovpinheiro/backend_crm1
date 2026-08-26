import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { isMetaGraphError } from "@/lib/meta-whatsapp/client";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";

type RouteContext = { params: Promise<{ id: string }> };

function requireAdminOrManager(session: { user?: { role?: string } }): NextResponse | null {
  const r = session.user?.role;
  if (r !== "ADMIN" && r !== "MANAGER") {
    return NextResponse.json({ message: "Apenas administrador ou gestor." }, { status: 403 });
  }
  return null;
}

/**
 * DELETE: remove o template na WABA.
 *
 * O `id` da rota é o `id` Graph da listagem (vai como `hsm_id`) e o `name` vem
 * na query string — a Graph exige os dois: sem `name` ela não aceita a
 * exclusão (ver `MetaWhatsAppClient.deleteMessageTemplate`).
 */
export async function DELETE(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const roleDenied = requireAdminOrManager(session);
      if (roleDenied) return roleDenied;

      const url = new URL(request.url);
      const channelId = url.searchParams.get("channelId");
      const name = url.searchParams.get("name")?.trim() ?? "";

      const { id } = await context.params;
      if (!id?.trim()) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }
      if (!name) {
        return NextResponse.json(
          {
            message:
              "Nome do template é obrigatório para excluir na Meta. Atualize a lista de templates e tente novamente.",
          },
          { status: 400 },
        );
      }

      const resolved = await resolveMetaTemplatesClient({
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
        channelId,
      });
      if (!resolved.ok) return resolved.response;

      const data = await resolved.client.deleteMessageTemplate({
        name,
        templateGraphId: id.trim(),
      });
      return NextResponse.json(data ?? { success: true });
    } catch (e: unknown) {
      console.error("[meta-templates] DELETE", e);
      // `fbtrace_id` é o que o suporte da Meta pede para investigar uma
      // rejeição — sobe junto do texto para o operador poder copiar.
      if (isMetaGraphError(e)) {
        return NextResponse.json(
          {
            message: e.toPersistedString(),
            code: e.code,
            subcode: e.subcode,
            fbtraceId: e.fbtraceId,
          },
          { status: 502 },
        );
      }
      const msg = e instanceof Error ? e.message : "Erro ao excluir template na Meta.";
      return NextResponse.json({ message: msg }, { status: 502 });
    }
  });
}
