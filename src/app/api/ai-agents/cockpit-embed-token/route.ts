import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { withRateLimit } from "@/lib/rate-limit";
import {
  COCKPIT_EMBED_TTL_SECONDS,
  issueCockpitEmbedToken,
} from "@/services/cockpit-embed";

const log = getLogger("cockpit.embed");

/**
 * GET /api/ai-agents/cockpit-embed-token
 *
 * Emite o JWT curto (5 min) que o CRM entrega ao iframe do Cockpit IA na
 * página "Agentes de IA". O cockpit usa esse token como
 * `Authorization: Bearer` em `GET /api/public/agent-cockpit`.
 *
 * A organização vem SEMPRE do contexto da sessão — o cliente não pode
 * escolher `orgId`. Sem isso o embed herdaria o comportamento single-tenant
 * do modo standalone (`COCKPIT_ORGANIZATION_ID`) e vazaria dados entre orgs.
 *
 * Resposta: `{ token, expiresInSeconds }`.
 */
export async function GET() {
  return withOrgContext(async (session) => {
    const rl = await withRateLimit({
      route: "GET /api/ai-agents/cockpit-embed-token",
      profile: "api.default",
      scope: "user",
      id: session.user.id,
    });
    if (!rl.ok) return rl.response as unknown as NextResponse;

    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Sessão sem organização." },
        { status: 403 },
      );
    }

    try {
      const token = await issueCockpitEmbedToken({
        orgId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { token, expiresInSeconds: COCKPIT_EMBED_TTL_SECONDS },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      log.error({ err: e, orgId }, "cockpit embed token issue failed");
      return NextResponse.json(
        { message: "Falha ao emitir token do cockpit." },
        { status: 500 },
      );
    }
  });
}
