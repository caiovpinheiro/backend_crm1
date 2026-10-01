import { NextResponse } from "next/server";

import { isAdmin, withOrgContext } from "@/lib/auth-helpers";
import { withRateLimit } from "@/lib/rate-limit";
import { isValidWidgetSlug } from "@/lib/widget-catalog";
import {
  InvalidWidgetSlugError,
  uninstallWidget,
} from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/widgets/uninstall");

/**
 * POST /api/widgets/uninstall
 * Body: { slug: string }
 * Desativa um widget para a organizacao (status INACTIVE, sem delete). Apenas ADMIN.
 * A validacao de existencia ocorre no service.
 * TODO(authz): migrar para permission key "settings:widgets" quando existir.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    if (!isAdmin(session)) {
      return NextResponse.json(
        { message: "Apenas administradores podem remover widgets." },
        { status: 403 },
      );
    }

    const rl = await withRateLimit({
      route: "POST /api/widgets/uninstall",
      profile: "api.default",
      scope: "org",
      id: session.user.organizationId,
    });
    if (!rl.ok) return rl.response as unknown as NextResponse;

    const body = (await request.json().catch(() => null)) as {
      slug?: unknown;
    } | null;
    const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
    if (!slug || !isValidWidgetSlug(slug)) {
      return NextResponse.json(
        { message: "Widget inválido." },
        { status: 400 },
      );
    }

    try {
      await uninstallWidget(slug);
      return NextResponse.json({ slug, installed: false });
    } catch (e) {
      if (e instanceof InvalidWidgetSlugError) {
        return NextResponse.json({ message: "Widget inválido." }, { status: 400 });
      }
      log.error({ err: e }, "[POST /api/widgets/uninstall] falhou");
      return NextResponse.json(
        { message: "Erro ao remover widget." },
        { status: 500 },
      );
    }
  });
}
