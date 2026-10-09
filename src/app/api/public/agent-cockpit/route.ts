import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { getCockpitData } from "@/services/distribution/cockpit";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/public/agent-cockpit");

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Cockpit do Agente (somente leitura). Autenticação pelo caminho comum da
 * API (`withApiAuthContext`):
 *   - Sessão NextAuth — o cockpit nativo do CRM (página Agentes de IA) chama
 *     esta rota same-origin pelo rewrite do frontend, com o cookie de sessão;
 *     a organização vem da sessão e vale o teto por sessão/organização.
 *   - Bearer token de integração (`eduit_...`) — organização do token.
 */
export async function GET(request: Request) {
  return withApiAuthContext(request, async () => {
    try {
      const data = await getCockpitData();
      return noStoreJson(data);
    } catch (e) {
      log.error({ err: e }, "[cockpit] falha ao montar métricas");
      return noStoreJson(
        { message: "Erro ao carregar o cockpit." },
        { status: 500 },
      );
    }
  });
}
