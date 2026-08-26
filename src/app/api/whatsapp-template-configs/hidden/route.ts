import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { ensureWhatsappTemplateHiddenAtColumn } from "@/lib/meta-whatsapp/ensure-hidden-at";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";

/**
 * Ocultar/reexibir template no CRM — independente da Meta.
 *
 * A lista de templates da tela de Configurações é lida AO VIVO da Graph, então
 * um template que a Meta se recusa a excluir (em uso por campanha, janela de 30
 * dias) reaparece a cada refresh. Marcar `hiddenAt` no config local resolve o
 * incômodo sem mentir sobre a Meta: lá o template continua existindo.
 *
 * Ocultar NÃO quebra envio: `send_whatsapp_template` resolve o template por
 * `metaTemplateName` sem filtrar `hiddenAt`. Uma automação que já referencia o
 * nome continua enviando normalmente — por isso o GET devolve quem usa, para o
 * operador decidir com informação.
 */

function requireAdminOrManager(session: {
  user?: { role?: string };
}): NextResponse | null {
  const r = session.user?.role;
  if (r !== "ADMIN" && r !== "MANAGER") {
    return NextResponse.json(
      { message: "Apenas administrador ou gestor." },
      { status: 403 },
    );
  }
  return null;
}

/** Automações cujo passo `send_whatsapp_template` aponta para este nome. */
async function findAutomationUsage(templateName: string) {
  const steps = await prisma.automationStep.findMany({
    where: {
      type: "send_whatsapp_template",
      // O nome fica em `config.templateName`; comparação exata via path JSON
      // evita falso positivo de template cujo nome é prefixo de outro.
      config: { path: ["templateName"], equals: templateName },
    },
    select: {
      automation: { select: { id: true, number: true, name: true, active: true } },
    },
  });

  const byId = new Map<
    string,
    { id: string; number: number; name: string; active: boolean }
  >();
  for (const s of steps) {
    if (s.automation) byId.set(s.automation.id, s.automation);
  }
  const automations = [...byId.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.number - b.number,
  );
  return {
    automations,
    activeCount: automations.filter((a) => a.active).length,
  };
}

/** GET ?name=<metaTemplateName> — quem usa o template (para confirmar antes). */
export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
      if (!name) {
        return NextResponse.json(
          { message: "Parâmetro `name` obrigatório." },
          { status: 400 },
        );
      }
      const usage = await findAutomationUsage(name);
      return NextResponse.json(usage);
    } catch (e) {
      console.error("[whatsapp-template-configs/hidden] GET", e);
      return NextResponse.json(
        { message: "Erro ao consultar uso do template." },
        { status: 500 },
      );
    }
  });
}

/**
 * POST { metaTemplateId, metaTemplateName, hidden }
 *
 * Faz upsert porque template que nunca recebeu label/mapeamento não tem linha
 * de config — e é justamente o caso comum de "quero só esconder esse aí".
 * Preserva os demais campos: ao contrário do PUT da rota irmã, aqui só
 * `hiddenAt` é escrito.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const denied = requireAdminOrManager(session);
      if (denied) return denied;

      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const metaTemplateId =
        typeof body.metaTemplateId === "string" ? body.metaTemplateId.trim() : "";
      const metaTemplateName =
        typeof body.metaTemplateName === "string"
          ? body.metaTemplateName.trim()
          : "";
      if (!metaTemplateId || !metaTemplateName) {
        return NextResponse.json(
          { message: "metaTemplateId e metaTemplateName obrigatórios." },
          { status: 400 },
        );
      }
      const hidden = body.hidden !== false;

      const orgId = getOrgIdOrThrow();
      await ensureWhatsappTemplateHiddenAtColumn();
      const config = await prisma.whatsAppTemplateConfig.upsert({
        where: {
          organizationId_metaTemplateId: {
            organizationId: orgId,
            metaTemplateId,
          },
        },
        create: withOrgFromCtx({
          metaTemplateId,
          metaTemplateName,
          hiddenAt: hidden ? new Date() : null,
        }),
        update: { hiddenAt: hidden ? new Date() : null },
      });

      const usage = await findAutomationUsage(metaTemplateName);
      return NextResponse.json({ config, ...usage });
    } catch (e) {
      console.error("[whatsapp-template-configs/hidden] POST", e);
      return NextResponse.json(
        { message: "Erro ao ocultar template." },
        { status: 500 },
      );
    }
  });
}
