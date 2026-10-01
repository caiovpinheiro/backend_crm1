import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { recordHeartbeat } from "@/services/system-presence";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/agents/me/ping");

export const dynamic = "force-dynamic";

/**
 * Heartbeat de PRESENÇA DE USO ("CRM aberto") enviado pelo cliente
 * (`usePresenceHeartbeat`) a cada ~90s enquanto houver uma aba do CRM aberta.
 *
 * IMPORTANTE — separação vs Distribuição:
 *   Antes este ping mexia em `AgentStatus` (promovia AWAY→ONLINE e alimentava
 *   `lastActivityAt` para o reaper). Isso confundia "sistema aberto" com
 *   "disponível para distribuição". Agora o ping SOMENTE grava presença de
 *   uso em `SystemUsageSession` — `AgentStatus` fica exclusivo do controle
 *   manual do agente (Online/Ausente/Offline).
 *
 * Compatível com o frontend antigo: a rota permanece em `/api/agents/me/ping`
 * e responde 200 igual antes.
 */
export async function POST() {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      // Super-admin sem org não tem presença por org.
      return NextResponse.json({ ok: true, systemOnline: true });
    }

    try {
      const { created } = await recordHeartbeat({ userId, organizationId });
      return NextResponse.json({ ok: true, systemOnline: true, created });
    } catch (err) {
      // Não spamar log em produção — geralmente indica migration pendente.
      const isMigrationPending =
        err instanceof Error &&
        (err.message.includes("system_usage_sessions") ||
          (err as { code?: string }).code === "P2021");
      if (!isMigrationPending) {
        log.warn({ err: err instanceof Error ? err.message : err }, "[/api/agents/me/ping] falhou");
      }
      return NextResponse.json(
        { ok: false, _migrationPending: true },
        { status: 200 },
      );
    }
  });
}
