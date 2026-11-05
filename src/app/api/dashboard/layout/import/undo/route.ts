/**
 * POST /api/dashboard/layout/import/undo
 * Volta ao dashboard que o usuário tinha antes da última importação.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { undoDashboardImport } from "@/services/dashboard-layout-transfer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = getLogger("api/dashboard/layout/import/undo");

export async function POST() {
  return withOrgContext(async (session) => {
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json({ message: "Nada para desfazer." }, { status: 404 });
    }
    try {
      const undone = await undoDashboardImport({ userId: session.user.id, organizationId });
      if (!undone) {
        return NextResponse.json({ message: "Não há importação para desfazer." }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      log.error("Falha ao desfazer importação de dashboard:", err);
      return NextResponse.json(
        { message: "Não foi possível desfazer a importação." },
        { status: 500 },
      );
    }
  });
}
