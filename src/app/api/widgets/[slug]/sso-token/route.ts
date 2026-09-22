import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { isSafePartnerIframeSrc } from "@/lib/partner-iframe-url";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withRateLimit } from "@/lib/rate-limit";
import { getTenantBaseDomain } from "@/lib/tenant-url";
import { isValidWidgetSlug } from "@/lib/widget-catalog";
import { issueWidgetSsoToken } from "@/services/widget-sso";

const log = getLogger("widgets.sso");

/**
 * GET /api/widgets/[slug]/sso-token
 *
 * Emite um JWT SSO curto (5min) que o CRM passa pro iframe do widget
 * de parceiro. Pre-condicoes:
 *   1) Usuario autenticado na org (qualquer role).
 *   2) Widget existe, tem `ownerType=PARTNER` e esta com `status=ONLINE`.
 *      (INTERNAL nao usa SSO — renderiza por rota propria.)
 *   3) A org tem o widget instalado (`OrganizationWidget.status=ACTIVE`).
 *
 * Resposta: `{ token, exp }` — `exp` em epoch seconds pra UI refrescar.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  return withOrgContext(async (session) => {
    const { slug: rawSlug } = await context.params;
    const slug = typeof rawSlug === "string" ? rawSlug.trim() : "";
    if (!slug || !isValidWidgetSlug(slug)) {
      return NextResponse.json({ message: "Slug inválido." }, { status: 400 });
    }

    // Rate limit por usuario — protege contra script malicioso
    // emitindo tokens em loop. Profile padrao (600/min) eh confortavel
    // pra UX (token renova de 4 em 4 min) mas atalha enumeracao.
    const rl = await withRateLimit({
      route: "GET /api/widgets/:slug/sso-token",
      profile: "api.default",
      scope: "user",
      id: session.user.id,
    });
    if (!rl.ok) return rl.response as unknown as NextResponse;

    const widget = await prismaBase.widget.findUnique({
      where: { slug },
      select: { ownerType: true, status: true, iframeUrl: true },
    });
    if (!widget) {
      return NextResponse.json({ message: "Widget não encontrado." }, { status: 404 });
    }
    if (widget.ownerType !== "PARTNER") {
      return NextResponse.json(
        { message: "Widget interno não usa SSO." },
        { status: 400 },
      );
    }
    if (widget.status !== "ONLINE" || !widget.iframeUrl) {
      return NextResponse.json(
        { message: "Widget não está disponível." },
        { status: 409 },
      );
    }
    if (
      !isSafePartnerIframeSrc(widget.iframeUrl, {
        tenantBaseDomain: getTenantBaseDomain(),
        apiOrigin: new URL(_request.url).origin,
      })
    ) {
      return NextResponse.json(
        { message: "Widget não está disponível." },
        { status: 409 },
      );
    }

    const installation = await prisma.organizationWidget.findUnique({
      where: {
        organizationId_widgetSlug: {
          organizationId: session.user.organizationId ?? "",
          widgetSlug: slug,
        },
      },
      select: { status: true },
    });
    if (installation?.status !== "ACTIVE") {
      return NextResponse.json(
        { message: "Widget não instalado nesta organização." },
        { status: 403 },
      );
    }

    // Org name e user name vem do banco/sessao. Usamos `prismaBase` na
    // organization (modelo nao tenant-scoped) so pra ler o `name`.
    const orgId = session.user.organizationId ?? "";
    const [org] = await Promise.all([
      prismaBase.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      }),
    ]);

    try {
      const token = await issueWidgetSsoToken({
        orgId,
        orgName: org?.name ?? "",
        userId: session.user.id,
        userName: session.user.name ?? "",
        userEmail: session.user.email ?? "",
        widgetSlug: slug,
      });
      log.info(
        { orgId, userId: session.user.id, slug },
        "widget sso token issued",
      );
      return NextResponse.json({
        token,
        iframeUrl: widget.iframeUrl,
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    } catch (e) {
      log.error({ err: e, orgId, slug }, "widget sso token issue failed");
      return NextResponse.json(
        { message: "Falha ao emitir token SSO." },
        { status: 500 },
      );
    }
  });
}
