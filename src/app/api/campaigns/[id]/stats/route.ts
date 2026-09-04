import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getCampaignStats } from "@/services/campaigns";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:view");
    if (denied) return denied;
    try {
      const { id } = await params;
      const stats = await getCampaignStats(id);
      return NextResponse.json(stats);
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao buscar estatísticas." },
        { status: 500 },
      );
    }
  });
}
