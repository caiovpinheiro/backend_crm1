import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  getDashboard,
  type DashboardResult,
} from "@/services/dashboard";
import { resolvePipelineByPublicRef } from "@/services/pipelines";

/**
 * GET /api/dashboard
 *
 * Dashboard comercial (Fase 1). Aceita:
 *   - period: today | yesterday | last_7 | last_30 | this_month | last_month | custom
 *   - startDate, endDate: YYYY-MM-DD (usados quando period=custom)
 *   - pipeline: number da org (`?pipeline=12`); também aceita slug legado
 *   - pipelineId: CUID interno (compat); se for só dígitos, trata como number
 *   - stages, tags, owners, sources: listas separadas por vírgula
 *
 * Todas as agregações respeitam esses filtros e o escopo da organização.
 */

type Range = { from: Date; to: Date };

function parseDay(value: string | null, end: boolean): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function computeRange(
  period: string | null,
  startDate: string | null,
  endDate: string | null,
): Range {
  if (period === "custom") {
    const from = parseDay(startDate, false);
    const to = parseDay(endDate, true);
    if (from && to) return { from, to };
  }

  const now = new Date();
  const from = new Date(now);
  const to = new Date(now);

  switch (period) {
    case "today":
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    case "yesterday":
      from.setDate(from.getDate() - 1);
      from.setHours(0, 0, 0, 0);
      to.setDate(to.getDate() - 1);
      to.setHours(23, 59, 59, 999);
      break;
    case "last_7":
      from.setDate(from.getDate() - 7);
      from.setHours(0, 0, 0, 0);
      break;
    case "last_30":
      from.setDate(from.getDate() - 30);
      from.setHours(0, 0, 0, 0);
      break;
    case "last_month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      const last = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: first, to: last };
    }
    case "this_month":
    default:
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      break;
  }
  return { from, to };
}

function csv(value: string | null): string[] {
  return value
    ? value.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
}

function emptyDashboard(pipelineId: string): DashboardResult {
  return {
    pipelineId,
    summary: {
      totalValue: 0,
      openDeals: 0,
      winRate: 0,
      avgTicket: 0,
      newContacts: 0,
      wonCount: 0,
      lostCount: 0,
      wonValue: 0,
      lostValue: 0,
      leadsWithoutOwner: 0,
      avgTimeToWinDays: 0,
      deltas: { winRate: 0, avgTicket: 0, wonCount: 0, wonValue: 0 },
    },
    newDeals: {
      count: 0,
      value: 0,
      open: 0,
      won: 0,
      lost: 0,
      wonValue: 0,
      lostValue: 0,
    },
    funnel: [],
    bySource: [],
    byOwner: [],
    byTag: [],
    lossReasons: [],
    dailyEvolution: [],
    stalled: [],
  };
}

export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const { from, to } = computeRange(
        searchParams.get("period"),
        searchParams.get("startDate"),
        searchParams.get("endDate"),
      );

      let pipelineId = searchParams.get("pipelineId") || "";
      const pipelineRef = searchParams.get("pipeline");
      const isAll =
        pipelineRef === "all" ||
        pipelineId === "all" ||
        pipelineId === "__all__";
      if (isAll) {
        const data = await getDashboard({
          from,
          to,
          pipelineId: "",
          stageIds: csv(searchParams.get("stages")),
          tagIds: csv(searchParams.get("tags")),
          ownerIds: csv(searchParams.get("owners")),
          sources: csv(searchParams.get("sources")),
        });
        return NextResponse.json(data);
      }
      if (pipelineRef && (!pipelineId || /^\d+$/.test(pipelineId))) {
        const resolved = await resolvePipelineByPublicRef(pipelineRef);
        if (resolved) pipelineId = resolved.id;
      } else if (pipelineId && /^\d+$/.test(pipelineId)) {
        const resolved = await resolvePipelineByPublicRef(pipelineId);
        if (resolved) pipelineId = resolved.id;
      }
      if (!pipelineId) {
        const def =
          (await prisma.pipeline.findFirst({
            where: { isDefault: true, archivedAt: null },
            select: { id: true },
          })) ??
          (await prisma.pipeline.findFirst({
            where: { archivedAt: null },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          }));
        pipelineId = def?.id ?? "";
      }

      if (!pipelineId) {
        return NextResponse.json(emptyDashboard(""));
      }

      const data = await getDashboard({
        from,
        to,
        pipelineId,
        stageIds: csv(searchParams.get("stages")),
        tagIds: csv(searchParams.get("tags")),
        ownerIds: csv(searchParams.get("owners")),
        sources: csv(searchParams.get("sources")),
      });

      return NextResponse.json(data);
    } catch (e) {
      console.error("[api/dashboard]", e);
      return NextResponse.json(
        { message: "Erro ao carregar o dashboard." },
        { status: 500 },
      );
    }
  });
}
