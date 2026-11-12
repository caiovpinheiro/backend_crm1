import { lifecycleResponse, withIntegrationsApi } from "@/lib/integrations-api";
import { pauseCampaign } from "@/services/campaign-lifecycle";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withIntegrationsApi(request, "campaign:send", async () => {
    const { id } = await params;
    return lifecycleResponse(await pauseCampaign(id));
  });
}
