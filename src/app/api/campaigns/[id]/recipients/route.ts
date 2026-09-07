import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getCampaignRecipients } from "@/services/campaigns";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:view");
    if (denied) return denied;
    try {
      const { id } = await params;
      const { searchParams } = new URL(request.url);

      const result = await getCampaignRecipients({
        campaignId: id,
        status: searchParams.get("status") ?? undefined,
        errorCode: searchParams.get("errorCode"),
        page: Number(searchParams.get("page")) || 1,
        perPage: Number(searchParams.get("perPage")) || 50,
      });

      return NextResponse.json(result);
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao listar destinatários." },
        { status: 500 },
      );
    }
  });
}
