import { lifecycleResponse, withIntegrationsApi } from "@/lib/integrations-api";
import { launchCampaign } from "@/services/campaign-lifecycle";

/** Lança um rascunho. Recusa público que resolve para todos os contatos. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withIntegrationsApi(request, "campaign:send", async () => {
    const { id } = await params;
    return lifecycleResponse(
      await launchCampaign(id, { requireRestrictiveAudience: true }),
    );
  });
}
