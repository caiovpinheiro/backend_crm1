import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { canViewStage, loadAuthzContext } from "@/lib/authz";
import { funnelDealWhere, andDealWhere } from "@/lib/authz/funnel-visibility";
import { requirePipelineScope } from "@/lib/authz/resource-policy";
import { getVisibilityFilter } from "@/lib/visibility";
import {
  BoardColumnPageError,
  getBoardColumnPages,
  isValidDealStatus,
  type BoardColumnPageRequest,
  type BoardSortDirection,
  type BoardSortField,
} from "@/services/deals";
import { parseAdvancedDealFilters } from "@/services/kanban-filters";
import { getPipelineMeta, resolvePipelineByPublicRef } from "@/services/pipelines";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/pipelines/[id]/board/columns");

function parseBoardSortField(raw: unknown): BoardSortField | undefined {
  return raw === "createdAt" || raw === "position" || raw === "lastInteraction"
    ? raw
    : undefined;
}

function parseBoardSortDirection(raw: unknown): BoardSortDirection | undefined {
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

function parseColumns(raw: unknown): BoardColumnPageRequest[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: BoardColumnPageRequest[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { stageId, cursor, limit } = item as Record<string, unknown>;
    if (typeof stageId !== "string" || stageId.length === 0) return null;
    if (typeof cursor !== "string" || cursor.length === 0) return null;
    out.push({
      stageId,
      cursor,
      limit: typeof limit === "number" && Number.isFinite(limit) ? limit : undefined,
    });
  }
  return out;
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "Carregar mais" do board por cursor (keyset).
 *
 * POST /api/pipelines/:id/board/columns
 *   { status?, filters?, sort?, direction?,
 *     columns: [{ stageId, cursor, limit? }] }
 * →  { columns: [{ stageId, deals, totalCount, nextCursor, hasMore }] }
 *
 * `cursor` é o `nextCursor` que a etapa trouxe no board (GET/POST /board) ou
 * na página anterior. `status`/`filters`/`sort`/`direction` têm de ser os
 * mesmos do board que originou o cursor. Devolve só os próximos `limit`
 * cards de cada etapa pedida — não recarrega o board nem cria entrada no
 * cache dele.
 *
 * Autorização idêntica à do POST /board (mesma sequência: authz, escopo do
 * pipeline, visibilidade do usuário, visibilidade de funil) e etapa que o
 * usuário não pode ver não é consultada.
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
      const authz = await loadAuthzContext({
        userId: session.user.id,
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
      });

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
      const body = (bodyJson ?? {}) as {
        status?: string;
        filters?: unknown;
        sort?: unknown;
        direction?: unknown;
        columns?: unknown;
      };

      const requested = parseColumns(body.columns);
      if (!requested) {
        return NextResponse.json(
          { message: "Informe `columns` com `stageId` e `cursor`.", code: "invalid_request" },
          { status: 400 },
        );
      }
      const columns = requested.filter((c) => canViewStage(authz, c.stageId));
      if (columns.length === 0) {
        return NextResponse.json({ columns: [] });
      }

      const statusParam = body.status;
      const statusFilter =
        statusParam === "ALL"
          ? ("ALL" as const)
          : statusParam && isValidDealStatus(statusParam)
            ? (statusParam as "OPEN" | "WON" | "LOST")
            : undefined;

      const pages = await getBoardColumnPages(
        pipelineId,
        andDealWhere(visibility.dealWhere, funnelDealWhere(authz)),
        statusFilter,
        parseAdvancedDealFilters(body.filters),
        {
          sortField: parseBoardSortField(body.sort),
          sortDirection: parseBoardSortDirection(body.direction),
          columns,
        },
      );
      return NextResponse.json({ columns: pages });
    } catch (e) {
      if (e instanceof BoardColumnPageError) {
        return NextResponse.json({ message: e.message, code: e.code }, { status: 400 });
      }
      log.error({ err: e }, "[board columns POST] erro ao carregar mais cards");
      const message = e instanceof Error ? e.message : "Erro ao carregar cards.";
      return NextResponse.json(
        { message: "Erro ao carregar cards.", detail: message },
        { status: 500 },
      );
    }
  });
}
