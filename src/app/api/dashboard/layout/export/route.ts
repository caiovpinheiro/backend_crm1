/**
 * GET /api/dashboard/layout/export
 * Arquivo JSON com o dashboard do usuário logado (widgets, grid, filtros e
 * ordem por aba) para outro gestor da MESMA organização importar.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  buildDashboardExportFile,
  getActiveDashboardLayout,
} from "@/services/dashboard-layout-transfer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return withOrgContext(async (session) => {
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json(
        { message: "Super-admin não tem dashboard para exportar." },
        { status: 400 },
      );
    }
    const record = await getActiveDashboardLayout(session.user.id);
    const file = buildDashboardExportFile({
      organizationId,
      user: {
        id: session.user.id,
        name: (session.user as { name?: string | null }).name ?? null,
      },
      record,
    });
    return NextResponse.json(file, { headers: { "Cache-Control": "no-store" } });
  });
}
