import { lifecycleResponse, withIntegrationsApi } from "@/lib/integrations-api";
import { cancelCampaign } from "@/services/campaign-lifecycle";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withIntegrationsApi(request, "campaign:cancel", async () => {
    const { id } = await params;
    return lifecycleResponse(await cancelCampaign(id));
  });
}
