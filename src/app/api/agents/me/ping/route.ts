import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { consumePresencePingSlot, presenceTabId } from "@/lib/presence-ping-limit";
import { recordHeartbeatThrottled } from "@/services/system-presence";
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
 * Gravação limitada: várias abas / pings de foco do mesmo usuário viram no
 * máximo 1 UPDATE a cada 45 s (`recordHeartbeatThrottled`); o limite de
 * inatividade para aparecer offline é 300 s.
 *
 * Compatível com o frontend antigo: a rota permanece em `/api/agents/me/ping`
 * e responde 200 igual antes.
 *
 * Limite: no máximo 1 ping a cada 20 s por usuário e aba (header `x-tab-id`;
 * sem ele, por usuário). Excedeu → 429 `{ retryAfterMs }` + `Retry-After`
 * (segundos). Sessão revogada/expirada responde antes, 401 `SESSION_REVOKED`
 * (`withOrgContext` → `requireAuth`). O ping NÃO conta como atividade real
 * para a expiração por inatividade.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;

    const slot = await consumePresencePingSlot({
      userId,
      tabId: presenceTabId(request.headers),
    });
    if (!slot.ok) {
      return NextResponse.json(
        { retryAfterMs: slot.retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.max(1, Math.ceil(slot.retryAfterMs / 1000))) },
        },
      );
    }
    if (!organizationId) {
      // Super-admin sem org não tem presença por org.
      return NextResponse.json({ ok: true, systemOnline: true });
    }

    try {
      // No máximo 1 gravação por usuário a cada 45 s (claim no Redis); os
      // pings intermediários respondem 200 sem tocar no banco.
      const { created } = await recordHeartbeatThrottled({
        userId,
        organizationId,
      });
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
