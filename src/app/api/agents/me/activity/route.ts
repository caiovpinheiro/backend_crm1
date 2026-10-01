import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  clampInteractionCount,
  recordSystemActivity,
} from "@/services/system-activity";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/agents/me/activity");

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/me/activity
 *
 * Coleta de USO REAL. Recebe pulsos agregados do tracker do cliente:
 *   Body: { interactionCount: number }
 *
 * Ao contrário do heartbeat de presença (`/api/agents/me/ping`), este
 * endpoint só é chamado quando o cliente detectou interação humana real
 * com aba visível. Sem toast, sem SSE, sem retry — falha silenciosa é
 * aceitável (o próximo pulso reajusta).
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;

    // Super-admin sem org: nada a registrar (nunca vai chegar aqui do UI real).
    if (!organizationId) {
      return NextResponse.json({ ok: true });
    }

    let raw: unknown = null;
    try {
      raw = await request.json();
    } catch {
      raw = {};
    }
    const rawCount =
      raw && typeof raw === "object" && "interactionCount" in raw
        ? Number((raw as { interactionCount?: unknown }).interactionCount)
        : 1;
    const interactionCount = clampInteractionCount(rawCount);

    try {
      await recordSystemActivity({
        organizationId,
        userId,
        interactionCount,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isMigrationPending =
        msg.includes("system_activity_sessions") ||
        (err as { code?: string }).code === "P2021";
      if (isMigrationPending) {
        return NextResponse.json({ ok: false, _migrationPending: true });
      }
      log.warn({ err: msg }, "[/api/agents/me/activity] falhou");
      // Resposta segura: 200 pra não gerar toast/log ruidoso no cliente.
      return NextResponse.json({ ok: false });
    }
  });
}
