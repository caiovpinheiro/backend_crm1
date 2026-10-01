import { NextResponse } from "next/server";

import { isAdmin, withOrgContext } from "@/lib/auth-helpers";
import { withRateLimit } from "@/lib/rate-limit";
import { isValidWidgetSlug } from "@/lib/widget-catalog";
import {
  InvalidWidgetSlugError,
  installWidget,
} from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/widgets/install");

/**
 * POST /api/widgets/install
 * Body: { slug: string }
 * Instala/reativa um widget para a organizacao. Apenas ADMIN.
 * A validacao de existencia/status do widget ocorre no service
 * (`installWidget` lanca `InvalidWidgetSlugError` se o slug nao existe
 * no banco ou nao esta ONLINE no marketplace).
 * TODO(authz): migrar para permission key "settings:widgets" quando existir.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    if (!isAdmin(session)) {
      return NextResponse.json(
        { message: "Apenas administradores podem instalar widgets." },
        { status: 403 },
      );
    }

    const rl = await withRateLimit({
      route: "POST /api/widgets/install",
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
      await installWidget(slug, session.user.id);
      return NextResponse.json({ slug, installed: true });
    } catch (e) {
      if (e instanceof InvalidWidgetSlugError) {
        return NextResponse.json({ message: "Widget inválido." }, { status: 400 });
      }
      log.error({ err: e }, "[POST /api/widgets/install] falhou");
      return NextResponse.json(
        { message: "Erro ao instalar widget." },
        { status: 500 },
      );
    }
  });
}
