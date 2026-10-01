import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import {
  cockpitCorsHeaders,
  tryCockpitAccessAuth,
  tryCockpitEmbedAuth,
} from "@/lib/cockpit-access";
import { runWithContext } from "@/lib/request-context";
import { getCockpitData } from "@/services/distribution/cockpit";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/public/agent-cockpit");

function jsonWithCors(request: Request, body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(cockpitCorsHeaders(request))) {
    headers.set(k, v);
  }
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

async function serveCockpitData(request: Request) {
  try {
    const data = await getCockpitData();
    return jsonWithCors(request, data);
  } catch (e) {
    log.error({ err: e }, "[cockpit] falha ao montar métricas");
    return jsonWithCors(
      request,
      { message: "Erro ao carregar o cockpit." },
      { status: 500 },
    );
  }
}

/**
 * Cockpit do Agente (somente leitura). Autenticação (qualquer uma):
 *   - Header `X-Cockpit-Access` + env COCKPIT_* (URL dedicada, zero setup)
 *   - Bearer com JWT de embed (iframe do cockpit dentro do CRM) — org vem do
 *     token, emitido para a sessão do usuário
 *   - Bearer token de integração
 *   - Sessão NextAuth (mesmo domínio do CRM)
 */
export async function OPTIONS(request: Request) {
  const cors = cockpitCorsHeaders(request);
  if (!Object.keys(cors).length) {
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function GET(request: Request) {
  const cockpitCtx = tryCockpitAccessAuth(request);
  if (cockpitCtx) {
    return runWithContext(cockpitCtx, () => serveCockpitData(request));
  }

  // Token de embed reconhecido pelo issuer: quando ele é inválido/expirado
  // respondemos 401 direto em vez de cair na sessão — o iframe precisa do
  // sinal claro pra pedir um token novo.
  const embed = await tryCockpitEmbedAuth(request);
  if (embed.kind === "ok") {
    return runWithContext(embed.context, () => serveCockpitData(request));
  }
  if (embed.kind === "rejected") {
    return jsonWithCors(
      request,
      { message: "Token do cockpit inválido ou expirado.", reason: embed.reason },
      { status: 401 },
    );
  }

  return withApiAuthContext(request, async () => serveCockpitData(request));
}
