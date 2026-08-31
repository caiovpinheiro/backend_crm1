import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { repairOrgTemplateMedia } from "@/lib/storage/repair-template-media";

export const maxDuration = 300;

/**
 * POST /api/templates/repair-media
 *
 * Repara mídias de modelos da org atual (message_templates + quick_replies)
 * cujo objeto não está no driver ativo. ADMIN da org ou super-admin.
 *
 * STORAGE_FALLBACK_URL (opcional, temporário no EasyPanel): GET 700ms no
 * host legado `banco-backend-crm.6tqx2r.easypanel.host` ou volume antigo.
 * Só esse host é chamado — a URL crua do modelo nunca é fetched (SSRF).
 *
 * Resposta: { repaired, missing, skipped } com nomes. Reenvie só `missing`.
 */
export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;

  const role = (r.session.user as { role?: string }).role;
  const isOrgAdmin = role === "ADMIN";
  const isPlatformAdmin = Boolean(r.session.user.isSuperAdmin);
  if (!isOrgAdmin && !isPlatformAdmin) {
    return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
  }

  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json(
      { message: "Selecione uma organização para reparar as mídias." },
      { status: 400 },
    );
  }

  try {
    const result = await repairOrgTemplateMedia({
      orgId,
      cookieHeader: request.headers.get("cookie"),
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[templates/repair-media]", e);
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao reparar mídias." },
      { status: 500 },
    );
  }
}
