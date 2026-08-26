import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  ensureWhatsappTemplateHiddenAtColumn,
  isMissingHiddenAtColumn,
} from "@/lib/meta-whatsapp/ensure-hidden-at";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function GET() {
  return withOrgContext(async () => {
    try {
      await ensureWhatsappTemplateHiddenAtColumn();
      let configs;
      try {
        configs = await prisma.whatsAppTemplateConfig.findMany({
          orderBy: { metaTemplateName: "asc" },
        });
      } catch (e) {
        if (!isMissingHiddenAtColumn(e)) throw e;
        configs = await prisma.whatsAppTemplateConfig.findMany({
          orderBy: { metaTemplateName: "asc" },
          omit: { hiddenAt: true },
        });
      }
      return NextResponse.json(configs);
    } catch (e) {
      console.error("[whatsapp-template-configs] GET", e);
      return NextResponse.json(
        { message: "Erro ao carregar templates." },
        { status: 500 },
      );
    }
  });
}

export async function PUT(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const role = (session.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json({ message: "Apenas administrador ou gestor." }, { status: 403 });
      }

      const body = (await request.json()) as Record<string, unknown>;
      const metaTemplateId = typeof body.metaTemplateId === "string" ? body.metaTemplateId.trim() : "";
      const metaTemplateName = typeof body.metaTemplateName === "string" ? body.metaTemplateName.trim() : "";
      if (!metaTemplateId || !metaTemplateName) {
        return NextResponse.json({ message: "metaTemplateId e metaTemplateName obrigatórios." }, { status: 400 });
      }

      const label = typeof body.label === "string" ? body.label.trim() : "";
      const agentEnabled = body.agentEnabled === true;
      const language = typeof body.language === "string" ? body.language.trim() || "pt_BR" : "pt_BR";
      const category = typeof body.category === "string" ? body.category.trim() || null : null;
      const bodyPreview = typeof body.bodyPreview === "string" ? body.bodyPreview.slice(0, 500) : "";

      const hasButtons = body.hasButtons === true;
      const hasVariables = body.hasVariables === true;
      const buttonTypes = Array.isArray(body.buttonTypes)
        ? (body.buttonTypes as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const flowAction =
        typeof body.flowAction === "string" && body.flowAction.trim() ? body.flowAction.trim() : null;
      const flowId = typeof body.flowId === "string" && body.flowId.trim() ? body.flowId.trim() : null;

      let operatorVariables: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined;
      if (Object.prototype.hasOwnProperty.call(body, "operatorVariables")) {
        const raw = body.operatorVariables;
        if (raw === null) {
          operatorVariables = Prisma.JsonNull;
        } else if (Array.isArray(raw)) {
          const cleaned = raw
            .map((row) => {
              if (!row || typeof row !== "object" || Array.isArray(row)) return null;
              const o = row as Record<string, unknown>;
              const key = typeof o.key === "string" ? o.key.trim() : "";
              const label = typeof o.label === "string" ? o.label.trim() : "";
              if (!key) return null;
              const example = typeof o.example === "string" && o.example.trim() ? o.example.trim() : undefined;
              // `crmField` é o token do CRM que preenche o marcador no envio
              // (`{{dealCustomFields.x}}`). Nunca vai para a Meta — o corpo
              // aprovado lá continua com `{{1}}`.
              const crmField =
                typeof o.crmField === "string" && o.crmField.trim() ? o.crmField.trim() : undefined;
              return {
                key,
                label: label || key,
                ...(example ? { example } : {}),
                ...(crmField ? { crmField } : {}),
              };
            })
            .filter(
              (x): x is { key: string; label: string; example?: string; crmField?: string } =>
                x != null,
            );
          operatorVariables = cleaned as unknown as Prisma.InputJsonValue;
        }
      }

      const orgId = getOrgIdOrThrow();
      await ensureWhatsappTemplateHiddenAtColumn();
      const config = await prisma.whatsAppTemplateConfig.upsert({
        where: { organizationId_metaTemplateId: { organizationId: orgId, metaTemplateId } },
        create: withOrgFromCtx({
          metaTemplateId,
          metaTemplateName,
          label,
          agentEnabled,
          language,
          category,
          bodyPreview,
          hasButtons,
          hasVariables,
          buttonTypes,
          flowAction,
          flowId,
          ...(operatorVariables !== undefined ? { operatorVariables } : {}),
        }),
        update: {
          metaTemplateName,
          label,
          agentEnabled,
          language,
          category,
          bodyPreview,
          hasButtons,
          hasVariables,
          buttonTypes,
          flowAction,
          flowId,
          ...(operatorVariables !== undefined ? { operatorVariables } : {}),
        },
      });

      return NextResponse.json(config);
    } catch (e) {
      console.error("[whatsapp-template-configs] PUT", e);
      return NextResponse.json(
        { message: "Erro ao salvar template." },
        { status: 500 },
      );
    }
  });
}
