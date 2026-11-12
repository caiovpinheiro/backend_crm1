import { NextResponse } from "next/server";

import { campaignNotFound, withIntegrationsApi } from "@/lib/integrations-api";
import { prisma } from "@/lib/prisma";
import { getCampaignStats } from "@/services/campaigns";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withIntegrationsApi(request, "campaign:view", async () => {
    const { id } = await params;
    const exists = await prisma.campaign.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return campaignNotFound();
    return NextResponse.json(await getCampaignStats(id));
  });
}
