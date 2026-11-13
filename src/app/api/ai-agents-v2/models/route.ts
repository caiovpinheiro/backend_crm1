import { NextResponse } from "next/server";

import { isAdmin, isSuperAdmin, requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getOrgModelCatalog } from "@/services/ai-v2/model-catalog";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/models");

/** Catálogo de modelos da organização (fixos + descobertos) e a última atualização. */
export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const catalog = await getOrgModelCatalog(r.session.user.organizationId!);
      return NextResponse.json({ ...catalog, canManage: isAdmin(r.session) || isSuperAdmin(r.session) });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/models]");
      return NextResponse.json({ message: "Erro ao carregar os modelos." }, { status: 500 });
    }
  });
}
