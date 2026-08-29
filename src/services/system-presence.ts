/**
 * Serviço de PRESENÇA DE USO do CRM ("aba aberta").
 *
 * Independente de `AgentStatus` (disponibilidade manual da Distribuição).
 * O ping do cliente (`POST /api/agents/me/ping`) chama `recordHeartbeat`
 * a cada ~90s enquanto houver uma aba aberta. Um sweeper fecha sessões
 * cujo último heartbeat expirou.
 *
 * Modelo:
 *   - Uma linha em `system_usage_sessions` por sessão. Enquanto
 *     `endedAt IS NULL` a sessão está aberta.
 *   - Partial unique `(userId) WHERE endedAt IS NULL` garante que
 *     múltiplas abas do mesmo usuário convergem para a MESMA sessão.
 *   - `lastHeartbeatAt` é atualizado a cada ping; se estiver vencido
 *     no sweep, `endedAt = lastHeartbeatAt` (para o relatório de uso
 *     não contar o gap final).
 *
 * Multi-tenancy: usa `prismaBase` + `organizationId` explícito porque
 * roda tanto dentro de RequestContext (rota ping) quanto de sweeper
 * global (sem ctx), e evita overhead da extension em hot path.
 */

import { prismaBase } from "@/lib/prisma-base";
import { sseBus } from "@/lib/sse-bus";

/**
 * Cadência do heartbeat (client) — 90s. O `STALE_MS` precisa ser
 * MAIOR pra tolerar jitter/renegociação de aba minimizada.
 */
export const SYSTEM_PRESENCE_HEARTBEAT_MS = 90_000;
export const SYSTEM_PRESENCE_STALE_MS = 150_000;

const SWEEP_INTERVAL_MS = 60_000;

let sweeperStarted = false;

interface HeartbeatResult {
  sessionId: string;
  created: boolean;
}

/**
 * Registra um heartbeat de uso. Idempotente:
 *   - Se já existe sessão aberta do usuário: atualiza `lastHeartbeatAt`.
 *   - Caso contrário: cria uma nova sessão (transição offline → online).
 *
 * Retorna `{ created: true }` quando abriu nova sessão — o caller usa
 * para emitir o SSE de "systemOnline: true" só na borda.
 */
export async function recordHeartbeat(params: {
  userId: string;
  organizationId: string;
  at?: Date;
}): Promise<HeartbeatResult> {
  const { userId, organizationId } = params;
  const at = params.at ?? new Date();

  // Fast path: update da sessão aberta.
  const updated = await prismaBase.systemUsageSession.updateMany({
    where: { userId, organizationId, endedAt: null },
    data: { lastHeartbeatAt: at },
  });

  if (updated.count > 0) {
    // Sessão existente — pega o id pra retorno.
    const open = await prismaBase.systemUsageSession.findFirst({
      where: { userId, organizationId, endedAt: null },
      select: { id: true },
    });
    return { sessionId: open?.id ?? "", created: false };
  }

  // Sem sessão aberta: INSERT … ON CONFLICT no partial unique
  // (`system_usage_sessions_open_per_user_uq`). Dois pings em paralelo
  // no primeiro heartbeat não podem gerar P2002/23505 — o perdedor
  // reusa a sessão e só o insert emite SSE.
  const id = crypto.randomUUID();
  const rows = await prismaBase.$queryRaw<
    Array<{ id: string; created: boolean }>
  >`
    INSERT INTO "system_usage_sessions"
      ("id", "organizationId", "userId", "startedAt", "lastHeartbeatAt", "endedAt", "createdAt", "updatedAt")
    VALUES
      (${id}, ${organizationId}, ${userId}, ${at}, ${at}, NULL, ${at}, ${at})
    ON CONFLICT ("userId") WHERE ("endedAt" IS NULL)
    DO UPDATE SET
      "lastHeartbeatAt" = EXCLUDED."lastHeartbeatAt",
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id", (xmax = 0) AS created
  `;
  const row = rows[0];
  if (row?.created) {
    sseBus.publish("system_presence_update", {
      organizationId,
      userId,
      systemOnline: true,
      lastSeenAt: at.toISOString(),
    });
    return { sessionId: row.id, created: true };
  }
  return { sessionId: row?.id ?? "", created: false };
}

/**
 * Fecha sessões abertas cujo último heartbeat passou de `STALE_MS`.
 * `endedAt` é ancorado em `lastHeartbeatAt` (não em `now()`) — assim o
 * relatório não conta o gap "aba fechada silenciosamente".
 *
 * Roda cross-tenant (sweeper global): usa `prismaBase` e retorna
 * `organizationId` para publicar SSE no tenant correto.
 */
export async function sweepStaleSessions(): Promise<{ closed: number }> {
  const staleBefore = new Date(Date.now() - SYSTEM_PRESENCE_STALE_MS);

  // RETURNING para conseguir emitir SSE por usuário.
  const closed = await prismaBase.$queryRaw<
    {
      id: string;
      userId: string;
      organizationId: string;
      lastHeartbeatAt: Date;
    }[]
  >`
    WITH updated AS (
      UPDATE "system_usage_sessions"
      SET "endedAt" = "lastHeartbeatAt",
          "updatedAt" = NOW()
      WHERE "endedAt" IS NULL
        AND "lastHeartbeatAt" < ${staleBefore}
      RETURNING "id", "userId", "organizationId", "lastHeartbeatAt"
    )
    SELECT "id", "userId", "organizationId", "lastHeartbeatAt" FROM updated
  `;

  for (const row of closed) {
    sseBus.publish("system_presence_update", {
      organizationId: row.organizationId,
      userId: row.userId,
      systemOnline: false,
      lastSeenAt: row.lastHeartbeatAt.toISOString(),
    });
  }

  return { closed: closed.length };
}

/**
 * Retorna o estado atual de presença para um conjunto de usuários da org.
 * Um usuário é considerado "systemOnline" se tem sessão aberta cujo
 * `lastHeartbeatAt` está dentro da tolerância.
 *
 * `lastSeenAt` é o timestamp mais recente conhecido — heartbeat da
 * sessão aberta ou `endedAt` da última fechada.
 */
export async function getSystemPresenceMap(params: {
  organizationId: string;
  userIds?: string[];
}): Promise<
  Map<string, { systemOnline: boolean; lastSeenAt: Date | null }>
> {
  const { organizationId, userIds } = params;
  const result = new Map<
    string,
    { systemOnline: boolean; lastSeenAt: Date | null }
  >();

  if (userIds && userIds.length === 0) return result;

  const freshBefore = new Date(Date.now() - SYSTEM_PRESENCE_STALE_MS);

  // Sessões abertas frescas → systemOnline true.
  const openFresh = await prismaBase.systemUsageSession.findMany({
    where: {
      organizationId,
      endedAt: null,
      lastHeartbeatAt: { gte: freshBefore },
      ...(userIds ? { userId: { in: userIds } } : {}),
    },
    select: { userId: true, lastHeartbeatAt: true },
  });
  for (const s of openFresh) {
    result.set(s.userId, {
      systemOnline: true,
      lastSeenAt: s.lastHeartbeatAt,
    });
  }

  // Última atividade histórica (para "visto há X min") de quem NÃO está
  // online agora. Uma consulta groupBy resolve sem N+1.
  const missingUserIds = userIds
    ? userIds.filter((id) => !result.has(id))
    : undefined;

  if (!missingUserIds || missingUserIds.length > 0) {
    const grouped = await prismaBase.systemUsageSession.groupBy({
      by: ["userId"],
      where: {
        organizationId,
        ...(missingUserIds ? { userId: { in: missingUserIds } } : {}),
      },
      _max: { lastHeartbeatAt: true },
    });
    for (const g of grouped) {
      if (result.has(g.userId)) continue;
      result.set(g.userId, {
        systemOnline: false,
        lastSeenAt: g._max.lastHeartbeatAt ?? null,
      });
    }
  }

  // Preenche usuários sem histórico nenhum (nunca fizeram heartbeat).
  if (userIds) {
    for (const id of userIds) {
      if (!result.has(id)) {
        result.set(id, { systemOnline: false, lastSeenAt: null });
      }
    }
  }

  return result;
}

/**
 * Agregação de USO do CRM em uma janela [from, to] por usuário da org.
 *
 * "Tempo de uso" = soma dos intervalos [max(startedAt, from), min(endedAt|now, to)]
 * das sessões que se sobrepõem à janela. Sessões abertas ainda contam até
 * o "agora" (ou `to`, o que vier antes) — reflete uso corrente.
 *
 * Retornado em SEGUNDOS para o front converter (formato horas/min amigável).
 * Cross-tenant seguro: filtro explícito por `organizationId`.
 */
export interface SystemUsageAggregateRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  avatarUrl: string | null;
  totalSeconds: number;
  sessionCount: number;
  lastSeenAt: string | null;
  systemOnline: boolean;
}

export async function getSystemUsageAggregate(params: {
  organizationId: string;
  from: Date;
  to: Date;
}): Promise<SystemUsageAggregateRow[]> {
  const { organizationId, from, to } = params;

  // Sobreposição: session.start < to AND (endedAt IS NULL OR endedAt > from).
  const rows = await prismaBase.$queryRaw<
    {
      userId: string;
      name: string | null;
      email: string | null;
      avatarUrl: string | null;
      total_seconds: number | string;
      session_count: number | string;
      last_seen: Date | null;
      open_now: boolean;
    }[]
  >`
    WITH s AS (
      SELECT
        s."userId",
        GREATEST(s."startedAt", ${from}) AS eff_start,
        LEAST(COALESCE(s."endedAt", NOW()), ${to}) AS eff_end,
        s."endedAt" IS NULL AS is_open,
        s."lastHeartbeatAt"
      FROM "system_usage_sessions" s
      WHERE s."organizationId" = ${organizationId}
        AND s."startedAt" < ${to}
        AND (s."endedAt" IS NULL OR s."endedAt" > ${from})
    )
    SELECT
      u."id" AS "userId",
      u."name" AS name,
      u."email" AS email,
      u."avatarUrl" AS "avatarUrl",
      COALESCE(SUM(EXTRACT(EPOCH FROM (s.eff_end - s.eff_start))), 0)::bigint AS total_seconds,
      COUNT(s.*)::int AS session_count,
      MAX(s."lastHeartbeatAt") AS last_seen,
      BOOL_OR(COALESCE(s.is_open, false)) AS open_now
    FROM "users" u
    LEFT JOIN s ON s."userId" = u."id"
    WHERE u."organizationId" = ${organizationId}
    GROUP BY u."id", u."name", u."email", u."avatarUrl"
    ORDER BY total_seconds DESC, u."name" ASC
  `;

  const freshBefore = Date.now() - SYSTEM_PRESENCE_STALE_MS;

  return rows.map((r) => {
    const lastSeen = r.last_seen ? new Date(r.last_seen) : null;
    const isFresh = lastSeen ? lastSeen.getTime() >= freshBefore : false;
    return {
      userId: r.userId,
      userName: r.name,
      userEmail: r.email,
      avatarUrl: r.avatarUrl,
      totalSeconds: Number(r.total_seconds ?? 0),
      sessionCount: Number(r.session_count ?? 0),
      lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
      // "online agora" = tem sessão aberta E heartbeat fresco.
      systemOnline: r.open_now && isFresh,
    };
  });
}

/**
 * Boot do sweeper (chamado uma vez pelo sse-bus).
 */
export function startSystemPresenceSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;

  const tick = async () => {
    try {
      await sweepStaleSessions();
    } catch (err) {
      console.warn(
        "[system-presence] sweeper falhou:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  }, 12_000);

  console.info(
    `[system-presence] sweeper iniciado (STALE > ${SYSTEM_PRESENCE_STALE_MS}ms, tick ${SWEEP_INTERVAL_MS}ms)`,
  );
}
