/**
 * Base das rotas `/api/integrations/*`: API para sistemas externos.
 *
 * Só token de API (`Authorization: Bearer eduit_…`): em produção o token é
 * aceito apenas no processo `api-public`, então estas rotas nunca rodam no
 * processo da API privada (inbox). Sessão recebe 401. Autentica pelo mesmo
 * `withApiAuthContext` das demais rotas da API pública, exige organização e
 * checa a permissão RBAC do dono do token.
 */
import { NextResponse } from "next/server";

import { withApiAuthContext, type ApiUser } from "@/lib/api-auth";
import type { PermissionKey } from "@/lib/authz";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import type { LifecycleFailure, LifecycleResult } from "@/services/campaign-lifecycle";

const log = getLogger("api/integrations");

export type IntegrationUser = ApiUser & { organizationId: string };

export async function withIntegrationsApi(
  request: Request,
  permission: PermissionKey,
  handler: (user: IntegrationUser) => Promise<NextResponse>,
): Promise<NextResponse> {
  return withApiAuthContext(request, async (user) => {
    // Bearer válido → ator INTEGRATION (`authenticateApiRequest`); sessão → HUMAN.
    if (user.actor?.type !== "INTEGRATION") {
      return NextResponse.json(
        {
          message: "Esta rota aceita apenas token de API (Authorization: Bearer).",
          code: "bearer_required",
        },
        { status: 401 },
      );
    }
    if (!user.organizationId) {
      return NextResponse.json({ message: "Token sem organização." }, { status: 401 });
    }
    const denied = await requirePermissionForUser(user, permission);
    if (denied) return denied;
    try {
      return await handler(user as IntegrationUser);
    } catch (err) {
      let path = "";
      try {
        path = new URL(request.url).pathname;
      } catch {
        path = "";
      }
      log.error({ err, method: request.method, path }, "[api/integrations] falhou");
      return NextResponse.json({ message: "Erro interno." }, { status: 500 });
    }
  });
}

export function lifecycleFailureResponse(failure: LifecycleFailure): NextResponse {
  return NextResponse.json(
    { message: failure.message, ...(failure.code ? { code: failure.code } : {}) },
    { status: failure.httpStatus },
  );
}

/** Mesmo corpo das rotas de sessão: `{ message, status }`. */
export function lifecycleResponse(result: LifecycleResult): NextResponse {
  if (!result.ok) return lifecycleFailureResponse(result);
  return NextResponse.json({ message: result.message, status: result.status });
}

export function campaignNotFound(): NextResponse {
  return NextResponse.json({ message: "Campanha não encontrada." }, { status: 404 });
}
