import { NextResponse } from "next/server";

import type { AppSession } from "@/lib/auth-helpers";
import { withOrgContext } from "@/lib/auth-helpers";
import { canViewStage, loadAuthzContext } from "@/lib/authz";
import { funnelDealWhere, andDealWhere } from "@/lib/authz/funnel-visibility";
import { requirePipelineScope } from "@/lib/authz/resource-policy";
import { ServerTiming } from "@/lib/server-timing";
import { getVisibilityFilter } from "@/lib/visibility";
import { boardStageScope } from "@/services/board-cache-variant";
import {
  getBoardJson,
  isValidDealStatus,
  type BoardLimitOptions,
  type BoardSortDirection,
  type BoardSortField,
} from "@/services/deals";
import { parseAdvancedDealFilters, type AdvancedDealFilters } from "@/services/kanban-filters";
import { getPipelineMeta, resolvePipelineByPublicRef } from "@/services/pipelines";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/pipelines/[id]/board");

/** Acima disto o tempo do board vai para o log em `info` (sem ligar debug). */
const SLOW_BOARD_LOG_MS = 1_000;

/**
 * Tamanho da página: `perStage` ou `limit` por etapa (padrão 50, teto 200);
 * o resto de cada coluna vem por `POST /board/columns` com o `nextCursor`.
 *
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

function parseStatus(raw: unknown): "OPEN" | "WON" | "LOST" | "ALL" | undefined {
  if (raw === "ALL") return "ALL";
  return typeof raw === "string" && isValidDealStatus(raw)
    ? (raw as "OPEN" | "WON" | "LOST")
    : undefined;
}

/**
 * Cards por etapa pedidos pelo cliente: `perStage` (nome histórico) ou
 * `limit`. Só normaliza o tipo — padrão (50) e teto (200) são do serviço
 * (`normalizeBoardPerStage`), que também é quem monta a chave do cache.
 */
function parsePerStage(...raws: unknown[]): number | undefined {
  for (const raw of raws) {
    const n =
      typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.max(1, Math.floor(n));
  }
  return undefined;
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

/** O que GET (query string) e POST (corpo) pedem — o resto é o mesmo caminho. */
type BoardRequest = {
  view?: "stages";
  status?: "OPEN" | "WON" | "LOST" | "ALL";
  filters?: AdvancedDealFilters;
  limit: BoardLimitOptions;
};

/**
 * Caminho único do board (GET e POST): autorização, cache canônico e
 * resposta já serializada, com `Server-Timing` por fase.
 *
 * Toda checagem continua aqui: escopo do funil (`requirePipelineScope`),
 * visibilidade do usuário (`getVisibilityFilter` + funil/etapas do papel
 * no `where`) e filtro de etapas visíveis (`canViewStage`) — este agora
 * roda antes de guardar no cache, e o recorte de etapas entra na chave.
 */
async function loadBoard(
  session: AppSession,
  rawRef: string,
  readRequest: () => Promise<BoardRequest>,
  timing: ServerTiming,
  method: "GET" | "POST",
): Promise<NextResponse> {
  const resolved = await timing.time("pre", () => resolvePipelineByPublicRef(rawRef));
  const pipelineId = resolved?.id ?? rawRef;
  const user = session.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };

  const pre0 = performance.now();
  const authz = await loadAuthzContext({
    userId: session.user.id,
    organizationId: session.user.organizationId,
    isSuperAdmin: session.user.isSuperAdmin,
  });
  // Corpo/query antes da visibilidade: `view=stages` não precisa dela.
  const req = await readRequest();
  // Meta + scope + visibilidade em paralelo.
  const [meta, scopeDenied, visibility] = await Promise.all([
    resolved ? Promise.resolve(resolved) : getPipelineMeta(pipelineId),
    requirePipelineScope(session.user, "view", pipelineId),
    req.view === "stages" ? Promise.resolve(null) : getVisibilityFilter(user),
  ]);
  timing.add("pre", performance.now() - pre0);

  if (!meta) {
    return NextResponse.json({ message: "Pipeline não encontrado." }, { status: 404 });
  }
  if (scopeDenied) return scopeDenied;

  if (req.view === "stages") {
    const stages = (await getBoardStagesOnly(pipelineId)).filter((s) =>
      canViewStage(authz, s.id),
    );
    return NextResponse.json(stages);
  }

  const { json, source } = await getBoardJson(
    pipelineId,
    andDealWhere(visibility!.dealWhere, funnelDealWhere(authz)),
    req.status,
    req.filters,
    req.limit,
    {
      stageVisible: (stageId) => canViewStage(authz, stageId),
      stageScope: boardStageScope(authz),
      timing,
    },
  );

  const fields = {
    method,
    pipelineId,
    cache: source,
    chars: json.length,
    filtered: Boolean(req.filters && Object.keys(req.filters).length > 0),
    timing: timing.toJSON(),
  };
  if (timing.totalMs() >= SLOW_BOARD_LOG_MS) log.info(fields, "[board] lento");
  else log.debug(fields, "[board] tempos");

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Server-Timing": timing.header(),
    },
  });
}

function errorResponse(e: unknown, label: string): NextResponse {
  log.error({ err: e }, label);
  const message = e instanceof Error ? e.message : "Erro ao carregar quadro.";
  return NextResponse.json(
    { message: "Erro ao carregar quadro.", detail: message },
    { status: 500 },
  );
}

// Bug 24/abr/26: usavamos `auth()` direto. As chamadas getPipelineMeta /
// getVisibilityFilter / getBoardData rodam queries Prisma e dependem da
// extension multi-tenant pra resolver organizationId no where. Sem o
// AsyncLocalStorage scope ativo o handler estourava com
// `getOrgIdOrThrow: organization context ausente`, e o front renderizava
// "Erro ao carregar quadro." em /pipeline. withOrgContext envolve o
// handler em runWithContext.
export async function GET(request: Request, context: RouteContext) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    // `auth` = JWT + versão da sessão + rate limit (antes do handler).
    timing.add("auth", timing.totalMs());
    try {
      const { id: rawRef } = await context.params;
      if (!rawRef) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }
      const url = new URL(request.url);
      return await loadBoard(
        session,
        rawRef,
        async () => ({
          view: url.searchParams.get("view") === "stages" ? "stages" : undefined,
          status: parseStatus(url.searchParams.get("status")),
          limit: {
            perStage: parsePerStage(
              url.searchParams.get("perStage"),
              url.searchParams.get("limit"),
            ),
            sortField: parseBoardSortField(url.searchParams.get("sort")),
            sortDirection: parseBoardSortDirection(url.searchParams.get("direction")),
          },
        }),
        timing,
        "GET",
      );
    } catch (e) {
      return errorResponse(e, "[board GET] erro ao carregar quadro");
    }
  });
}

/**
 * Variante POST do board que aceita filtros avançados via body.
 *
 * Mesmo caminho e mesmo cache do GET: sem filtro, um POST cai na mesma
 * chave do GET equivalente. O frontend usa esta rota quando há filtros que
 * não cabem em query string (custom fields, ranges de data, múltiplas
 * tags, etc.).
 */
export async function POST(request: Request, context: RouteContext) {
  const timing = new ServerTiming();
  return withOrgContext(async (session) => {
    timing.add("auth", timing.totalMs());
    try {
      const { id: rawRef } = await context.params;
      if (!rawRef) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }
      return await loadBoard(
        session,
        rawRef,
        async () => {
          let bodyJson: unknown = null;
          try {
            bodyJson = await request.json();
          } catch {
            bodyJson = null;
          }
          const body = (bodyJson ?? {}) as {
            status?: unknown;
            filters?: unknown;
            perStage?: unknown;
            limit?: unknown;
            offsetByStage?: unknown;
            sort?: unknown;
            direction?: unknown;
          };
          const offsetByStage =
            body.offsetByStage && typeof body.offsetByStage === "object"
              ? (body.offsetByStage as Record<string, number>)
              : undefined;
          return {
            status: parseStatus(body.status),
            filters: parseAdvancedDealFilters(body.filters),
            limit: {
              perStage: parsePerStage(
                typeof body.perStage === "number" ? body.perStage : undefined,
                typeof body.limit === "number" ? body.limit : undefined,
              ),
              offsetByStage,
              sortField: parseBoardSortField(body.sort),
              sortDirection: parseBoardSortDirection(body.direction),
            },
          };
        },
        timing,
        "POST",
      );
    } catch (e) {
      return errorResponse(e, "[board POST] erro ao carregar quadro com filtros");
    }
  });
}
