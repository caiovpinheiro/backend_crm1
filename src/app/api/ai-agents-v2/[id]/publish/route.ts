import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { publishV2AgentVersion } from "@/services/ai-v2/agents";
import { blockingFindings, validateV2AgentConfig } from "@/services/ai-v2/config-validators";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/publish");

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  return runInSessionContext(r.session, async () => {
    try {
      await ensureV2AgentSchema();
      const orgId = r.session.user.organizationId!;
      const force = new URL(request.url).searchParams.get("force") === "1";
      if (!force) {
        // Achado que bloqueia barra a publicação; `?force=1` publica mesmo
        // assim. Falha ao carregar os dados da validação não impede publicar.
        try {
          const blocking = blockingFindings(await validateV2AgentConfig(orgId, id));
          if (blocking.length > 0) {
            return NextResponse.json(
              { message: `A configuração tem ${blocking.length} problema${blocking.length === 1 ? "" : "s"} que bloqueia${blocking.length === 1 ? "" : "m"} a publicação.`, code: "CONFIG_BLOCKED", findings: blocking },
              { status: 409 },
            );
          }
        } catch (err) {
          log.warn({ err, id }, "[POST /api/ai-agents-v2/[id]/publish] validação indisponível; publicando sem ela");
        }
      }
      const body = (await request.json().catch(() => ({}))) as { comment?: string };
      const result = await publishV2AgentVersion(id, orgId, r.session.user.id, body.comment);
      return NextResponse.json(result);
    } catch (err) {
      log.error({ err }, "[POST /api/ai-agents-v2/[id]/publish]");
      return NextResponse.json(
        { message: err instanceof Error ? err.message : "Erro ao publicar agente." },
        { status: 500 },
      );
    }
  });
}
