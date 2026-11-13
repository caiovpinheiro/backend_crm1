import { NextResponse } from "next/server";

import { lifecycleFailureResponse, withIntegrationsApi } from "@/lib/integrations-api";
import {
  findMissingCampaignReference,
  parseCampaignDraftBody,
} from "@/services/campaign-lifecycle";
import { createCampaign } from "@/services/campaigns";

/**
 * Cria campanha em rascunho. Mesmo corpo do `POST /api/campaigns`, com a
 * trava de público: sem `segmentId`, `filters` precisa restringir o público.
 */
export async function POST(request: Request) {
  return withIntegrationsApi(request, "campaign:create", async (user) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const parsed = parseCampaignDraftBody(body, user.id, {
      requireRestrictiveAudience: true,
    });
    if (!parsed.ok) return lifecycleFailureResponse(parsed);

    const missing = await findMissingCampaignReference(parsed.input);
    if (missing) return lifecycleFailureResponse(missing);

    const campaign = await createCampaign(parsed.input);
    return NextResponse.json({ campaign }, { status: 201 });
  });
}
