import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePipelineScope } from "@/lib/authz/resource-policy";
import { getVisibilityFilter } from "@/lib/visibility";
import {
  getBoardData,
  isValidDealStatus,
  type BoardSortDirection,
  type BoardSortField,
} from "@/services/deals";
import { parseAdvancedDealFilters } from "@/services/kanban-filters";
import { getPipelineMeta, resolvePipelineByPublicRef } from "@/services/pipelines";
import { prisma } from "@/lib/prisma";

/**
 * Aceita `sort` e `direction` vindos do client (GET via query string ou
 * POST via body). Retorna `undefined` quando o valor é omitido/inválido
 * pra que o serviço caia no default `position asc` (comportamento atual).
 */
function parseBoardSortField(raw: unknown): BoardSortField | undefined {
  return raw === "createdAt" || raw === "position" || raw === "lastInteraction"
    ? raw
    : undefined;
}

function parseBoardSortDirection(raw: unknown): BoardSortDirection | undefined {
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Stages leves (sem deals) — usado quando a UI só precisa do funil
 * (segmentos, move-to-stage) e NÃO do payload de cards (~900KB).
 */
async function getBoardStagesOnly(pipelineId: string) {
  const stages = await prisma.stage.findMany({
    where: { pipelineId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      number: true,
      color: true,
      position: true,
      winProbability: true,
      rottingDays: true,
      pipelineId: true,
      isIncoming: true,
      isWon: true,
      isLost: true,
    },
  });
  return stages.map((s) => ({
    ...s,
    conversionRate: 0,
    avgDaysInStage: 0,
    totalCount: 0,
    loadedCount: 0,
    hasMore: false,
    deals: [] as unknown[],
  }));
}

// Bug 24/abr/26: usavamos `auth()` direto. As chamadas getPipelineMeta /
// getVisibilityFilter / getBoardData rodam queries Prisma e dependem da
// extension multi-tenant pra resolver organizationId no where. Sem o
// AsyncLocalStorage scope ativo o handler estourava com
// `getOrgIdOrThrow: organization context ausente`, e o front renderizava
// "Erro ao carregar quadro." em /pipeline. withOrgContext envolve o
// handler em runWithContext.
export async function GET(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id: rawRef } = await context.params;
      if (!rawRef) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const resolved = await resolvePipelineByPublicRef(rawRef);
      const pipelineId = resolved?.id ?? rawRef;

      const user = session.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };
      const url = new URL(request.url);
      const view = url.searchParams.get("view");

      // Meta + scope + (visibility só se for board completo) em paralelo —
      // antes eram awaits em série somando round-trips.
      const [meta, scopeDenied, visibility] = await Promise.all([
        resolved ? Promise.resolve(resolved) : getPipelineMeta(pipelineId),
        requirePipelineScope(session.user, "view", pipelineId),
        view === "stages"
          ? Promise.resolve(null)
          : getVisibilityFilter(user),
      ]);

      if (!meta) {
        return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
      }
      if (scopeDenied) return scopeDenied;

      if (view === "stages") {
        const stages = await getBoardStagesOnly(pipelineId);
        return NextResponse.json(stages);
      }

      const statusParam = url.searchParams.get("status");
      const statusFilter = statusParam === "ALL"
        ? "ALL" as const
        : (statusParam && isValidDealStatus(statusParam) ? statusParam : undefined);

      const perStageRaw = url.searchParams.get("perStage");
      const perStage = perStageRaw ? Math.max(1, parseInt(perStageRaw, 10) || 0) : undefined;

      const sortField = parseBoardSortField(url.searchParams.get("sort"));
      const sortDirection = parseBoardSortDirection(url.searchParams.get("direction"));

      const board = await getBoardData(pipelineId, visibility!.dealWhere, statusFilter, undefined, {
        perStage,
        sortField,
        sortDirection,
      });
      return NextResponse.json(board);
    } catch (e) {
      console.error("[board GET] erro ao carregar quadro:", e);
      const message =
        e instanceof Error ? e.message : "Erro ao carregar quadro.";
      return NextResponse.json(
        { message: "Erro ao carregar quadro.", detail: message },
        { status: 500 },
      );
    }
  });
}

/**
 * Variante POST do board que aceita filtros avançados via body.
 *
 * Mantemos o GET intocado para compatibilidade — o frontend usa esta rota
 * quando há filtros que não cabem em query string (custom fields, ranges
 * de data, múltiplas tags, etc.).
 */
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id: rawRef } = await context.params;
      if (!rawRef) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const resolved = await resolvePipelineByPublicRef(rawRef);
      const pipelineId = resolved?.id ?? rawRef;

      const user = session.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };

      const [meta, scopeDenied, visibility] = await Promise.all([
        resolved ? Promise.resolve(resolved) : getPipelineMeta(pipelineId),
        requirePipelineScope(session.user, "view", pipelineId),
        getVisibilityFilter(user),
      ]);

      if (!meta) {
        return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
      }
      if (scopeDenied) return scopeDenied;

      let bodyJson: unknown = null;
      try {
        bodyJson = await request.json();
      } catch {
        bodyJson = null;
      }

      const body = (bodyJson ?? {}) as { status?: string; filters?: unknown };
      const statusParam = body.status;
      const statusFilter =
        statusParam === "ALL"
          ? ("ALL" as const)
          : statusParam && isValidDealStatus(statusParam)
            ? (statusParam as "OPEN" | "WON" | "LOST")
            : undefined;

      const filters = parseAdvancedDealFilters(body.filters);
      const limitOptions = {
        perStage:
          typeof (body as { perStage?: unknown }).perStage === "number"
            ? Math.max(1, Math.floor((body as { perStage: number }).perStage))
            : undefined,
        offsetByStage:
          (body as { offsetByStage?: Record<string, number> }).offsetByStage &&
          typeof (body as { offsetByStage?: Record<string, number> }).offsetByStage === "object"
            ? ((body as { offsetByStage: Record<string, number> }).offsetByStage)
            : undefined,
        sortField: parseBoardSortField((body as { sort?: unknown }).sort),
        sortDirection: parseBoardSortDirection((body as { direction?: unknown }).direction),
      };
      const board = await getBoardData(
        pipelineId,
        visibility.dealWhere,
        statusFilter,
        filters,
        limitOptions,
      );
      return NextResponse.json(board);
    } catch (e) {
      console.error("[board POST] erro ao carregar quadro com filtros:", e);
      const message =
        e instanceof Error ? e.message : "Erro ao carregar quadro.";
      return NextResponse.json(
        { message: "Erro ao carregar quadro.", detail: message },
        { status: 500 },
      );
    }
  });
}
