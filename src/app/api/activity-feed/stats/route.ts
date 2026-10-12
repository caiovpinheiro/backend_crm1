import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { cachedReport, type ReportCacheStatus } from "@/lib/report-cache";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { ServerTiming } from "@/lib/server-timing";
import { timedJson } from "@/lib/server-timing-response";
import {
  loadActivityFeedStats,
  parseActivityStatsWindow,
} from "@/services/activity-feed-stats";

const log = getLogger("api/activity-feed/stats");

export const dynamic = "force-dynamic";

/**
 * GET /api/activity-feed/stats
 *
 * Agregações sobre `activity_events` da org (ADMIN/MANAGER).
 *
 * Janela (precedência nesta ordem):
 *   - from / to          ISO 8601 ou AAAA-MM-DD (dia civil de São Paulo).
 *                        `dateFrom` / `dateTo` continuam aceitos (mesmo sentido).
 *                        Só from: até agora. Só to: os 30 dias antes dele.
 *   - period             today | yesterday | last_7 | last_30 | this_month |
 *                        last_month | custom (+ startDate/endDate AAAA-MM-DD),
 *                        igual a /api/painel/*.
 *   - nada               últimos 30 dias (contrato antigo).
 *   Teto de 366 dias (mantém o fim; `rangeClamped: true` quando corta).
 *   Data ou period inválido, ou from > to: 400.
 *
 * Cache por org + janela (ao minuto): 60 s fresco + 120 s vencido enquanto
 * recalcula (`cachedReport`). `Server-Timing`: auth, cache (hit|miss|stale),
 * query (só quando calculou), serialize, total.
 *
 * Resposta:
 *   {
 *     window: { from, to },
 *     totals: { total, byActorType: {...}, byEntityType: {...}, byType: [{ type, count }] (top 20) },
 *     timeline: [{ day: "2026-06-05", count }],          // dia civil de São Paulo
 *     timelineByActor: [{ day, HUMAN, AI, AUTOMATION, INTEGRATION, SYSTEM }],
 *     hourly: [{ hour: 0..23, count }]                    // hora de São Paulo
 *   }
 */
export async function GET(req: Request) {
  // Stats de logs: restrito a gestão (ADMIN/MANAGER). O contexto vem de
  // withOrgContext (runWithContext) — com requireManager, que usa enterWith,
  // o getOrgIdOrThrow() do handler explodia em produção.
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    timing.add("auth", timing.totalMs());
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }

    const parsed = parseActivityStatsWindow(new URL(req.url).searchParams);
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message }, { status: 400 });
    }
    const { from, to, rangeClamped } = parsed.window;

    try {
      const orgId = getOrgIdOrThrow();
      const cacheWaitStart = performance.now();
      const data = await cachedReport(
        "activity-feed-stats",
        orgId,
        { from, to },
        () => timing.time("query", () => loadActivityFeedStats(orgId, { from, to })),
        {
          onStatus: (status: ReportCacheStatus) =>
            timing.describeCache(
              new Map([["activity-feed-stats", status]]),
              performance.now() - cacheWaitStart,
            ),
        },
      );
      return timedJson(timing, rangeClamped ? { ...data, rangeClamped: true } : data);
    } catch (e) {
      log.error({ err: e }, "[activity-feed/stats] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar estatísticas de atividade." },
        { status: 500 },
      );
    }
  });
}
