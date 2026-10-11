import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { touchSessionActivity } from "@/lib/auth/session-activity";
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
 * (clique, tecla, navegação) desde o último envio. Sem toast, sem SSE, sem
 * retry — falha silenciosa é aceitável (o próximo pulso reajusta).
 *
 * Também é o que mantém a sessão viva: cada chamada com pulsos renova o
 * registro de atividade real da sessão (`touchSessionActivity`); sem ele por
 * `SESSION_IDLE_HOURS` (12 h) a sessão expira (401
 * `SESSION_REVOKED`). `interactionCount` ≤ 0 (ou `null`) NÃO é atividade:
 * responde `{ ok: true, recorded: false }` sem gravar nada. Corpo sem o
 * campo (cliente antigo) vale 1, como antes.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;

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
    // 0 pulsos não é interação real: não renova a sessão nem grava uso.
    if (Number.isFinite(rawCount) && rawCount <= 0) {
      return NextResponse.json({ ok: true, recorded: false });
    }
    const interactionCount = clampInteractionCount(rawCount);

    await touchSessionActivity({ userId, sid: session.user.sid });

    // Super-admin sem org: nada a registrar no relatório de uso.
    if (!organizationId) {
      return NextResponse.json({ ok: true });
    }

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
