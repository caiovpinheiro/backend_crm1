import { NextResponse } from "next/server";

import { campaignNotFound, withIntegrationsApi } from "@/lib/integrations-api";
import { getCampaignById } from "@/services/campaigns";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withIntegrationsApi(request, "campaign:view", async () => {
    const { id } = await params;
    const campaign = await getCampaignById(id);
    if (!campaign) return campaignNotFound();

    // `channel.config` guarda credenciais do canal: não sai nesta API.
    const channel = campaign.channel
      ? {
          id: campaign.channel.id,
          name: campaign.channel.name,
          provider: campaign.channel.provider,
          type: campaign.channel.type,
        }
      : null;
    return NextResponse.json({ campaign: { ...campaign, channel } });
  });
}
