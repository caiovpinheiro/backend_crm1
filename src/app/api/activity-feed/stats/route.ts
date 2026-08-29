import { NextResponse } from "next/server";

import { Prisma } from "@prisma/client";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

/**
 * GET /api/activity-feed/stats
 *
 * Agregacoes sobre `activity_events` org-scoped. Suporta um window
 * (default 30 dias). Usa $queryRawUnsafe pra agregacoes Postgres que
 * o Prisma Client nao expoe nativamente (date_trunc).
 *
 * Query params:
 *   - dateFrom  ISO (default: now() - 30 dias)
 *   - dateTo    ISO (default: now())
 *
 * Resposta:
 *   {
 *     totals: { total, byActorType: {...}, byEntityType: {...}, byType: [{ type, count }] },
 *     timeline: [{ day: "2026-06-05", count }],
 *     timelineByActor: [{ day, HUMAN, AI, AUTOMATION, INTEGRATION, SYSTEM }],
 *     hourly: [{ hour: 0..23, count }]
 *   }
 */
export async function GET(req: Request) {
  // Stats de logs: restrito a gestão (ADMIN/MANAGER). O contexto vem de
  // withOrgContext (runWithContext) — com requireManager, que usa enterWith,
  // o getOrgIdOrThrow() do handler explodia em produção.
  return withOrgContext((session) => handle(req, session));
}

/** A session achatada de auth-helpers não é exportada; deriva do helper. */
type OrgSession = Parameters<Parameters<typeof withOrgContext>[0]>[0];

function eachUtcDay(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  );
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

async function handle(req: Request, session: OrgSession) {
  try {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }

    const orgId = getOrgIdOrThrow();
    const url = new URL(req.url);
    const dateFromRaw = url.searchParams.get("dateFrom");
    const dateToRaw = url.searchParams.get("dateTo");
    const dateTo = dateToRaw ? new Date(dateToRaw) : new Date();
    const dateFrom = dateFromRaw
      ? new Date(dateFromRaw)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [byActor, byEntity, byType, timelineRows, hourlyRows, totalRow] =
      await Promise.all([
        prisma.activityEvent.groupBy({
          by: ["actorType"],
          where: {
            organizationId: orgId,
            occurredAt: { gte: dateFrom, lte: dateTo },
          },
          _count: { _all: true },
        }),
        prisma.activityEvent.groupBy({
          by: ["entityType"],
          where: {
            organizationId: orgId,
            occurredAt: { gte: dateFrom, lte: dateTo },
          },
          _count: { _all: true },
        }),
        prisma.activityEvent.groupBy({
          by: ["type"],
          where: {
            organizationId: orgId,
            occurredAt: { gte: dateFrom, lte: dateTo },
          },
          _count: { _all: true },
          orderBy: { _count: { type: "desc" } },
          take: 20,
        }),
        prisma.$queryRaw<{ day: Date; actorType: string; count: bigint }[]>(
          Prisma.sql`
        SELECT date_trunc('day', "occurredAt") AS day,
               "actorType",
               COUNT(*)::bigint AS count
        FROM "activity_events"
        WHERE "organizationId" = ${orgId}
          AND "occurredAt" >= ${dateFrom}
          AND "occurredAt" <= ${dateTo}
        GROUP BY 1, 2
        ORDER BY 1 ASC
      `,
        ),
        prisma.$queryRaw<{ hour: number; count: bigint }[]>(Prisma.sql`
        SELECT EXTRACT(HOUR FROM ("occurredAt" AT TIME ZONE 'America/Sao_Paulo'))::int AS hour,
               COUNT(*)::bigint AS count
        FROM "activity_events"
        WHERE "organizationId" = ${orgId}
          AND "occurredAt" >= ${dateFrom}
          AND "occurredAt" <= ${dateTo}
        GROUP BY 1
        ORDER BY 1
      `),
        prisma.activityEvent.count({
          where: {
            organizationId: orgId,
            occurredAt: { gte: dateFrom, lte: dateTo },
          },
        }),
      ]);

    const ACTORS = [
      "HUMAN",
      "AI",
      "AUTOMATION",
      "INTEGRATION",
      "SYSTEM",
    ] as const;

    const byDay = new Map<string, Record<(typeof ACTORS)[number], number>>();
    for (const row of timelineRows) {
      const day = row.day.toISOString().slice(0, 10);
      const actor = (ACTORS as readonly string[]).includes(row.actorType)
        ? (row.actorType as (typeof ACTORS)[number])
        : "SYSTEM";
      const bucket =
        byDay.get(day) ??
        ({
          HUMAN: 0,
          AI: 0,
          AUTOMATION: 0,
          INTEGRATION: 0,
          SYSTEM: 0,
        } satisfies Record<(typeof ACTORS)[number], number>);
      bucket[actor] += Number(row.count);
      byDay.set(day, bucket);
    }

    const emptyActors = () => ({
      HUMAN: 0,
      AI: 0,
      AUTOMATION: 0,
      INTEGRATION: 0,
      SYSTEM: 0,
    });

    const timelineByActor = eachUtcDay(dateFrom, dateTo).map((day) => {
      const counts = byDay.get(day) ?? emptyActors();
      return { day, ...counts };
    });

    const hourlyMap = new Map(
      hourlyRows.map((r) => [Number(r.hour), Number(r.count)]),
    );
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hourlyMap.get(hour) ?? 0,
    }));

    return NextResponse.json({
      window: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
      totals: {
        total: totalRow,
        byActorType: Object.fromEntries(
          byActor.map((r) => [r.actorType, r._count._all]),
        ),
        byEntityType: Object.fromEntries(
          byEntity.map((r) => [r.entityType, r._count._all]),
        ),
        byType: byType.map((r) => ({ type: r.type, count: r._count._all })),
      },
      timeline: timelineByActor.map((r) => ({
        day: r.day,
        count:
          r.HUMAN + r.AI + r.AUTOMATION + r.INTEGRATION + r.SYSTEM,
      })),
      timelineByActor,
      hourly,
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}
