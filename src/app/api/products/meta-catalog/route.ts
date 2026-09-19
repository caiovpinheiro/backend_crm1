import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { detectWabaProductCatalog } from "@/services/meta-catalog";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:view");
    if (denied) return denied;

    const url = new URL(request.url);
    const channelId = url.searchParams.get("channelId");
    const status = await detectWabaProductCatalog(channelId);
    return NextResponse.json(status);
  });
}
