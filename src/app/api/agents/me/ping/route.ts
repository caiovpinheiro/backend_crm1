import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { sessionRevokedBody } from "@/lib/auth/revoked-session";
import { parseLastInteractionAt, sessionIdleTimeoutMs } from "@/lib/auth/session-activity";
import {
  consumePresencePingSlot,
  consumePresencePingUserSlot,
  presenceTabId,
} from "@/lib/presence-ping-limit";
import { claimPresenceBeat, entityListSignature } from "@/lib/presence-beat";
import { recordHeartbeatThrottled } from "@/services/system-presence";
import { getLogger } from "@/lib/logger";
import { recordPresenceBeat } from "@/lib/metrics";

const log = getLogger("api/agents/me/ping");

export const dynamic = "force-dynamic";

function tooManyPings(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { retryAfterMs },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    },
  );
}

async function readLastInteractionAt(request: Request, now: number): Promise<number | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null; // sem corpo (cliente antigo) ou corpo inválido
  }
  if (!body || typeof body !== "object") return null;
  return parseLastInteractionAt((body as { lastInteractionAt?: unknown }).lastInteractionAt, now);
}

/**
 * Heartbeat de PRESENÇA DE USO ("CRM aberto") do frontend ANTIGO
 * (`usePresenceHeartbeat`, a cada ~90 s pela aba líder). O frontend novo usa
 * `POST /api/presence/beat`, que faz ping + heartbeat numa chamada só.
 *
 * Batida única por usuário: depois dos limites abaixo, o ping disputa o
 * MESMO limite da batida nova (`claimPresenceBeat`, 1 a cada
 * `PRESENCE_BEAT_MIN_INTERVAL_MS` = 30 s por usuário somando beat + ping +
 * heartbeat). Perdeu → 200 `{ ok: true, systemOnline: true, deduped: true,
 * sessionIdleMs }` sem gravar nada. Antes do limite, no-op: com QUALQUER
 * batida do usuário gravada há menos de `PRESENCE_BEAT_NOOP_WINDOW_MS`
 * (45 s; a presença do sistema está fresca) → 204 sem corpo e sem escrita
 * (`crm_presence_beats_total{route="ping",result="noop_204"}`).
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
 * (segundos). Além disso, teto por usuário somando as abas:
 * `PRESENCE_PING_USER_MAX_PER_MIN` (6) por janela de 60 s — só conta o ping
 * que passou pelo limite da aba; excedeu → o mesmo 429. Sessão
 * revogada/expirada responde antes, 401 `SESSION_REVOKED`
 * (`withOrgContext` → `requireAuth`). O ping NÃO conta como atividade real
 * para a expiração por inatividade.
 *
 * Inatividade informada pelo cliente: corpo opcional
 * `{ lastInteractionAt: ISO | epoch ms }` (última interação real do
 * usuário no navegador). Se `agora - lastInteractionAt` passou do limite
 * (`SESSION_IDLE_HOURS`) → 401 `{ code: "SESSION_REVOKED", reason: "idle" }`
 * sem gravar presença nenhuma e sem mexer em `sessionVersion` (os outros
 * dispositivos do usuário seguem logados). Dentro do limite, o ping segue
 * normal e NÃO renova a sessão (só `/api/agents/me/activity` renova). Valor
 * no futuro ou ilegível → campo ignorado. Sem o campo (cliente antigo) vale
 * só a checagem por Redis do `auth()`.
 *
 * Toda resposta 200 traz `sessionIdleMs` (o limite em ms) para a checagem
 * local do frontend.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    const organizationId = session.user.organizationId;
    const sessionIdleMs = sessionIdleTimeoutMs();

    const now = Date.now();
    const lastInteractionAt = await readLastInteractionAt(request, now);
    if (lastInteractionAt !== null && now - lastInteractionAt > sessionIdleMs) {
      return NextResponse.json(sessionRevokedBody("idle_timeout"), { status: 401 });
    }

    const slot = await consumePresencePingSlot({
      userId,
      tabId: presenceTabId(request.headers),
    });
    if (!slot.ok) return tooManyPings(slot.retryAfterMs);
    const userSlot = await consumePresencePingUserSlot({ userId });
    if (!userSlot.ok) return tooManyPings(userSlot.retryAfterMs);
    if (!organizationId) {
      // Super-admin sem org não tem presença por org.
      return NextResponse.json({ ok: true, systemOnline: true, sessionIdleMs });
    }

    // Ping não tem entidades: a assinatura gravada é a lista vazia.
    const beat = await claimPresenceBeat({
      userId,
      noop: { mode: "any" },
      writeSignature: entityListSignature([]),
    });
    if (!beat.accepted && beat.noop) {
      recordPresenceBeat("ping", "noop_204");
      return new NextResponse(null, { status: 204 });
    }
    if (!beat.accepted) {
      recordPresenceBeat("ping", "deduped");
      return NextResponse.json({ ok: true, systemOnline: true, deduped: true, sessionIdleMs });
    }
    recordPresenceBeat("ping", "written");

    try {
      // No máximo 1 gravação por usuário a cada 45 s (claim no Redis); os
      // pings intermediários respondem 200 sem tocar no banco.
      const { created } = await recordHeartbeatThrottled({
        userId,
        organizationId,
      });
      return NextResponse.json({ ok: true, systemOnline: true, created, sessionIdleMs });
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
        { ok: false, _migrationPending: true, sessionIdleMs },
        { status: 200 },
      );
    }
  });
}
