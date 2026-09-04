import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { updateCampaignStatus } from "@/services/campaigns";
import { prisma } from "@/lib/prisma";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:cancel");
    if (denied) return denied;
    try {
      const { id } = await params;

      const campaign = await prisma.campaign.findUnique({
        where: { id },
        select: { status: true },
      });

      if (!campaign) {
        return NextResponse.json({ message: "Campanha não encontrada." }, { status: 404 });
      }

      const cancellable = ["DRAFT", "SCHEDULED", "PROCESSING", "SENDING", "PAUSED"];
      if (!cancellable.includes(campaign.status)) {
        return NextResponse.json(
          { message: "Esta campanha não pode ser cancelada." },
          { status: 409 },
        );
      }

      await updateCampaignStatus(id, "CANCELLED");

      await prisma.campaignRecipient.updateMany({
        where: { campaignId: id, status: "PENDING" },
        data: { status: "FAILED", errorMessage: "Campanha cancelada." },
      });

      return NextResponse.json({ message: "Campanha cancelada.", status: "CANCELLED" });
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao cancelar campanha." },
        { status: 500 },
      );
    }
  });
}
