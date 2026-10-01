import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getCompanyFacets } from "@/services/companies";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/companies/facets");

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const facets = await getCompanyFacets();
      return NextResponse.json(facets);
    });
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: "Erro ao carregar filtros de empresas." },
      { status: 500 },
    );
  }
}
