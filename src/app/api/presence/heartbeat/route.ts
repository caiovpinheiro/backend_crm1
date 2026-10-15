import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { listViewers, removeViewer, touchViewer } from "@/lib/entity-presence";
import { getLogger } from "@/lib/logger";
import { recordPresenceBeat } from "@/lib/metrics";
import { claimPresenceBeat, entityListSignature } from "@/lib/presence-beat";
import { getPresenceUserInfo } from "@/lib/presence-user-info";
import { recordHeartbeatThrottled } from "@/services/system-presence";

const log = getLogger("api/presence/heartbeat");

export const dynamic = "force-dynamic";

/** Entidades que suportam presença "quem está vendo" no heartbeat ANTIGO.
 *  Allowlist evita salas arbitrárias criadas por payload malicioso. */
const ALLOWED_ENTITIES = new Set(["deal"]);

/**
 * Heartbeat de presença por entidade do frontend ANTIGO (1 chamada por
 * entidade aberta, ~25 s). O frontend novo usa `POST /api/presence/beat`,
 * que manda todas as entidades e a presença do sistema numa chamada só.
 *
 * Corpo: `{ entityType, entityId, action? }`. Sempre devolve a lista atual
 * de viewers da entidade (`{ viewers }`).
 *
 * - `action: "leave"` (`navigator.sendBeacon` no unmount / aba fechada):
 *   remove o viewer na hora. Não passa pelo limite e não gasta a batida
 *   (saída é rara e precisa ser imediata).
 * - Demais: disputa o limite único por usuário (`claimPresenceBeat`, 1 a
 *   cada `PRESENCE_BEAT_MIN_INTERVAL_MS` = 30 s somando beat + ping +
 *   heartbeat). Ganhou → renova o viewer e grava também a presença do
 *   sistema ("CRM aberto"), para o ping que perder a disputa não deixar o
 *   usuário offline. Perdeu → 200 `{ viewers, deduped: true }` lido do
 *   Redis, sem escrever.
 * - No-op (antes do limite): a entidade estava na lista da última batida
 *   GRAVADA do usuário, há menos de `PRESENCE_BEAT_NOOP_WINDOW_MS` (45 s) →
 *   204 sem corpo e sem escrita (o viewer já foi renovado).
 *
 * Limitação conhecida (só no frontend antigo): com 2+ deals abertos ao
 * mesmo tempo, as batidas de um deal podem ganhar sempre a disputa e o
 * outro deixar de mostrar o usuário. O `/beat` não tem isso (manda todas as
 * entidades juntas).
 */
export async function POST(req: Request) {
  return withOrgContext(async (session) => {
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json({ viewers: [] });
    }

    let body: { entityType?: unknown; entityId?: unknown; action?: unknown } = {};
    try {
      // sendBeacon pode mandar texto puro: lê como texto e parseia.
      body = JSON.parse(await req.text());
    } catch {
      body = {};
    }

    const entityType = String(body?.entityType ?? "");
    const entityId = String(body?.entityId ?? "");
    if (!ALLOWED_ENTITIES.has(entityType) || !entityId) {
      return NextResponse.json({ viewers: [] }, { status: 400 });
    }

    const userId = session.user.id;

    if (body.action === "leave") {
      const viewers = await removeViewer({ orgId, entityType, entityId, userId });
      return NextResponse.json({ viewers });
    }

    const ref = { entityType, entityId };
    const beat = await claimPresenceBeat({
      userId,
      noop: { mode: "contains", entityKey: `${entityType}:${entityId}` },
      writeSignature: entityListSignature([ref]),
    });
    if (!beat.accepted && beat.noop) {
      recordPresenceBeat("heartbeat", "noop_204");
      return new NextResponse(null, { status: 204 });
    }
    if (!beat.accepted) {
      recordPresenceBeat("heartbeat", "deduped");
      const viewers = await listViewers({ orgId, entityType, entityId });
      return NextResponse.json({ viewers, deduped: true });
    }

    const { name, avatarUrl } = await getPresenceUserInfo(userId);
    const [viewers] = await Promise.all([
      touchViewer({ orgId, entityType, entityId, userId, name, avatarUrl }),
      recordHeartbeatThrottled({ userId, organizationId: orgId }).catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : err }, "presença do sistema falhou");
      }),
    ]);
    recordPresenceBeat("heartbeat", "written");
    return NextResponse.json({ viewers });
  });
}
