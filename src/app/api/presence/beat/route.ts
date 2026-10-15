import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { sessionRevokedBody } from "@/lib/auth/revoked-session";
import { parseLastInteractionAt, sessionIdleTimeoutMs } from "@/lib/auth/session-activity";
import {
  beatViewers,
  entityRefKey,
  listViewersMany,
  type EntityRef,
  type EntityViewer,
} from "@/lib/entity-presence";
import { getLogger } from "@/lib/logger";
import { recordPresenceBeat } from "@/lib/metrics";
import {
  claimPresenceBeat,
  entityListSignature,
  parseBeatEntities,
  parseClientId,
  presenceBeatListKey,
  rememberEntityListInMemory,
  serializeEntityList,
} from "@/lib/presence-beat";
import { presenceBeatIntervalMs, presenceViewerTtlMs } from "@/lib/presence-beat-config";
import { getPresenceUserInfo } from "@/lib/presence-user-info";
import { recordHeartbeatThrottled } from "@/services/system-presence";

const log = getLogger("api/presence/beat");

export const dynamic = "force-dynamic";

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await request.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Presença do sistema ("CRM aberto"). Erro de banco não derruba a batida:
 * os viewers já foram renovados; a próxima batida aceita tenta de novo.
 */
async function recordSystemPresence(userId: string, organizationId: string): Promise<boolean> {
  try {
    const { created } = await recordHeartbeatThrottled({ userId, organizationId });
    return created;
  } catch (err) {
    const isMigrationPending =
      err instanceof Error &&
      (err.message.includes("system_usage_sessions") ||
        (err as { code?: string }).code === "P2021");
    if (!isMigrationPending) {
      log.warn({ err: err instanceof Error ? err.message : err }, "presença do sistema falhou");
    }
    return false;
  }
}

function onlyListed(
  viewers: Record<string, EntityViewer[]>,
  entities: EntityRef[],
): Record<string, EntityViewer[]> {
  const out: Record<string, EntityViewer[]> = {};
  for (const ref of entities) out[entityRefKey(ref)] = viewers[entityRefKey(ref)] ?? [];
  return out;
}

/**
 * Batida de presença ÚNICA por navegador: faz numa chamada o que
 * `POST /api/agents/me/ping` (presença do sistema + inatividade) e
 * `POST /api/presence/heartbeat` (quem está vendo, 1 chamada por entidade)
 * faziam.
 *
 * Corpo:
 *   {
 *     "tabId": "aba-123",                 // opcional, só diagnóstico
 *     "clientId": "nav-abc",              // opcional, id estável do navegador
 *     "lastInteractionAt": "2026-10-14T12:00:00.000Z" | 1760443200000,
 *     "entities": [{ "type": "deal", "id": "d1" }, { "type": "conversation", "id": "c9" }]
 *   }
 * `entities` = entidades abertas em TODAS as abas do navegador (até 20;
 * tipos aceitos: deal, conversation; outros são ignorados).
 *
 * Respostas:
 * - 204 sem corpo (no-op): a MESMA lista de entidades (normalizada e
 *   ordenada) da última batida GRAVADA do usuário, há menos de
 *   `PRESENCE_BEAT_NOOP_WINDOW_MS` (45 s) — outro navegador/perfil/WebView
 *   do mesmo usuário, ou aba com cadência própria. Nada é escrito nem lido
 *   além do script do limite; os viewers dessas entidades já foram renovados
 *   pela batida gravada. A janela conta da última escrita: a batida de
 *   cadência (60 s) de um navegador sozinho sempre grava.
 * - 200 escrita: `{ ok: true, sessionIdleMs, nextBeatMs, viewers, systemOnline: true }`
 *   — grava `system_usage_sessions.lastHeartbeatAt` (no máximo 1 UPDATE a
 *   cada 45 s por usuário), renova o usuário em todas as entidades listadas
 *   e o REMOVE das que estavam na batida anterior e saíram da lista (mesmo
 *   `clientId`, ou do usuário se não vier `clientId`) — um MULTI no Redis.
 * - 200 deduplicada: `{ ok: true, deduped: true, sessionIdleMs, nextBeatMs, retryAfterMs, viewers }`
 *   — lista DIFERENTE da gravada, e já houve batida aceita do usuário nos últimos
 *   `PRESENCE_BEAT_MIN_INTERVAL_MS` (30 s; somando abas, navegadores, ping e
 *   heartbeat antigos). Nada é escrito; `viewers` vem do Redis. Não é 429 de
 *   propósito (não vira erro nem retentativa no cliente). `retryAfterMs` =
 *   quando a próxima seria aceita — use só para antecipar uma batida quando
 *   a lista de entidades mudou; a cadência normal é `nextBeatMs`.
 * - 401 `{ code: "SESSION_REVOKED", reason: "idle" }`: `lastInteractionAt`
 *   mais antigo que o limite de inatividade (mesma regra do ping). Nada é
 *   gravado e a batida do usuário não é gasta.
 *
 * `viewers`: `{ "<tipo>:<id>": [{ userId, name, avatarUrl, lastSeen }] }`,
 * só das entidades enviadas (mesmo formato do heartbeat antigo).
 * `nextBeatMs` = `PRESENCE_BEAT_INTERVAL_MS` (60 s): cadência recomendada.
 * Classe de custo (d) acessória.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    const orgId = session.user.organizationId;
    const sessionIdleMs = sessionIdleTimeoutMs();
    const nextBeatMs = presenceBeatIntervalMs();
    const now = Date.now();

    const body = await readBody(request);
    const lastInteractionAt = parseLastInteractionAt(body.lastInteractionAt, now);
    if (lastInteractionAt !== null && now - lastInteractionAt > sessionIdleMs) {
      return NextResponse.json(sessionRevokedBody("idle_timeout"), { status: 401 });
    }

    const entities = parseBeatEntities(body.entities);
    if (!orgId) {
      // Super-admin sem org não tem presença por org.
      return NextResponse.json({ ok: true, sessionIdleMs, nextBeatMs, viewers: {} });
    }

    const listKey = presenceBeatListKey(orgId, userId, parseClientId(body.clientId));
    const signature = entityListSignature(entities);
    const gate = await claimPresenceBeat({
      userId,
      listKey,
      noop: { mode: "same", signature },
      writeSignature: signature,
    });
    if (!gate.accepted && gate.noop) {
      recordPresenceBeat("beat", "noop_204");
      return new NextResponse(null, { status: 204 });
    }
    if (!gate.accepted) {
      recordPresenceBeat("beat", "deduped");
      const viewers = await listViewersMany(orgId, entities);
      return NextResponse.json({
        ok: true,
        deduped: true,
        sessionIdleMs,
        nextBeatMs,
        retryAfterMs: gate.retryAfterMs,
        viewers,
      });
    }

    const listed = new Set(entities.map(entityRefKey));
    const remove = (gate.previous ?? []).filter((ref) => !listed.has(entityRefKey(ref)));
    const listValue = serializeEntityList(entities);
    const ttlMs = presenceViewerTtlMs();
    rememberEntityListInMemory(listKey, listValue, ttlMs);

    const { name, avatarUrl } = await getPresenceUserInfo(userId);
    const [viewers, created] = await Promise.all([
      beatViewers({
        orgId,
        userId,
        name,
        avatarUrl,
        touch: entities,
        remove,
        alsoSet: { key: listKey, value: listValue, ttlMs },
      }),
      recordSystemPresence(userId, orgId),
    ]);
    recordPresenceBeat("beat", "written");
    return NextResponse.json({
      ok: true,
      sessionIdleMs,
      nextBeatMs,
      systemOnline: true,
      created,
      viewers: onlyListed(viewers, entities),
    });
  });
}
