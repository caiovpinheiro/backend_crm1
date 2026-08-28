import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { invalidateWhatsappTemplateCatalog } from "@/lib/cache/keys";
import { cloneMessageTemplatesBetweenClients } from "@/lib/meta-whatsapp/clone-message-templates";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";

function requireAdminOrManager(session: { user?: { role?: string } }): NextResponse | null {
  const r = session.user?.role;
  if (r !== "ADMIN" && r !== "MANAGER") {
    return NextResponse.json({ message: "Apenas administrador ou gestor." }, { status: 403 });
  }
  return null;
}

/**
 * POST: clona message_templates da WABA do canal origem para a do canal destino.
 * Body: { sourceChannelId, targetChannelId, skipNames?: string[] }
 *
 * Não copia status APPROVED — cada create no destino entra em revisão na Meta.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const roleDenied = requireAdminOrManager(session);
      if (roleDenied) return roleDenied;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }
      const b = body as Record<string, unknown>;
      const sourceChannelId =
        typeof b.sourceChannelId === "string" ? b.sourceChannelId.trim() : "";
      const targetChannelId =
        typeof b.targetChannelId === "string" ? b.targetChannelId.trim() : "";
      if (!sourceChannelId || !targetChannelId) {
        return NextResponse.json(
          { message: "Informe sourceChannelId e targetChannelId." },
          { status: 400 },
        );
      }
      if (sourceChannelId === targetChannelId) {
        return NextResponse.json(
          { message: "Origem e destino devem ser canais diferentes." },
          { status: 400 },
        );
      }

      const skipNames = Array.isArray(b.skipNames)
        ? b.skipNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        : undefined;

      const source = await resolveMetaTemplatesClient({
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
        channelId: sourceChannelId,
      });
      if (!source.ok) return source.response;

      const target = await resolveMetaTemplatesClient({
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
        channelId: targetChannelId,
      });
      if (!target.ok) return target.response;

      if (source.client.wabaId && target.client.wabaId && source.client.wabaId === target.client.wabaId) {
        return NextResponse.json(
          {
            message:
              "Os dois canais apontam para a mesma WABA — templates já são compartilhados; clone desnecessário.",
          },
          { status: 400 },
        );
      }

      const report = await cloneMessageTemplatesBetweenClients({
        source: source.client,
        target: target.client,
        skipNames,
      });

      // O clone escreve na WABA de destino; o catálogo dela em cache ficou
      // velho. A de origem não muda.
      if (report.created.length > 0) {
        await invalidateWhatsappTemplateCatalog(
          session.user.organizationId,
          report.targetWabaId,
        );
      }

      return NextResponse.json({
        sourceChannelId: source.channelId,
        targetChannelId: target.channelId,
        ...report,
      });
    } catch (e: unknown) {
      console.error("[meta-templates] clone", e);
      const msg = e instanceof Error ? e.message : "Erro ao clonar templates na Meta.";
      return NextResponse.json({ message: msg }, { status: 502 });
    }
  });
}
