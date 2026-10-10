import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getAcademicCockpitCases } from "@/services/ai/cockpit-academic-cases";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/public/agent-cockpit/cases");

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Casos do cockpit do agente acadêmico. Mesma autenticação de
 * `GET /api/public/agent-cockpit` (sessão do CRM ou Bearer de integração); a
 * organização vem sempre do contexto autenticado.
 */
export async function GET(request: Request) {
  return withApiAuthContext(request, async () => {
    const url = new URL(request.url);
    const key = url.searchParams.get("key")?.trim() ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    try {
      const organizationId = getOrgIdOrThrow();
      const data = await getAcademicCockpitCases({ organizationId, key, page });
      return noStoreJson(data);
    } catch (e) {
      const status = (e as { status?: number }).status === 400 ? 400 : 500;
      const message =
        e instanceof Error ? e.message : "Erro ao carregar os casos.";
      log.error({ err: e }, "[cockpit] falha ao listar casos");
      return noStoreJson({ message }, { status });
    }
  });
}
