import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getNextActivityAlert } from "@/services/activity-alerts";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/activities/alerts");

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      if (!authResult.user.organizationId) {
        return NextResponse.json({ alert: null });
      }

      const alert = await getNextActivityAlert(
        authResult.user.id,
        authResult.user.organizationId,
      );

      return NextResponse.json({ alert });
    });
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao buscar alerta." }, { status: 500 });
  }
}
