import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getTabulationAnalytics } from "@/services/tabulation-analytics";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";
import { timedJson } from "@/lib/server-timing-response";
import { REPORT_MAX_RANGE_MS, cachedReport, type ReportCacheStatus } from "@/lib/report-cache";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { clampRangeFromEnd } from "@/services/painel-period";

const log = getLogger("api/analytics/tabulations");

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** CSV, chave repetida, ou singular (`actorUserId` / `departmentId`). */
function parseIdList(sp: URLSearchParams, ...keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    for (const raw of sp.getAll(key)) {
      for (const part of raw.split(",")) {
        const id = part.trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return out;
}

/**
 * `withOrgContext` (runWithContext) e nao `requireManager` (enterWith): o
 * servico chama `getOrgIdOrThrow()`, e o contexto ativado por enterWith nao
 * sobrevive ate lá em producao — as outras rotas de analytics ja haviam
 * migrado pelo mesmo motivo. Role checada na session, como em
 * /api/analytics/system-usage.
 */
export async function GET(request: Request) {
  // `Server-Timing`: auth, cache (espera pelo cache; desc = hit | miss | stale),
  // query (só quando calculou, ou seja, miss/stale), serialize, total.
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

    try {
      const { searchParams } = new URL(request.url);
      const now = new Date();
      const requestedFrom =
        parseDate(searchParams.get("from")) ??
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const to = parseDate(searchParams.get("to")) ?? now;
      // Teto de 366 dias (igual a /api/logs/system-usage): mantém o fim e recua o início.
      const range = clampRangeFromEnd({ from: requestedFrom, to }, REPORT_MAX_RANGE_MS);
      const from = range.from;
      const rangeClamped = from.getTime() !== requestedFrom.getTime();
      const actorUserIds = parseIdList(searchParams, "actorUserIds", "actorUserId");
      const departmentIds = parseIdList(searchParams, "departmentIds", "departmentId");
      const tabulationIds = parseIdList(searchParams, "tabulationIds", "tabulationId");
      const page = Number(searchParams.get("page") ?? "1");
      const perPage = Number(searchParams.get("perPage") ?? "25");

      const safePage = Number.isFinite(page) ? page : 1;
      const safePerPage = Number.isFinite(perPage) ? perPage : 25;
      // Cache por org + período (ao minuto) + filtros (ids ordenados) + página.
      // Página e tamanho entram na chave como o serviço os normaliza.
      const cacheWaitStart = performance.now();
      const data = await cachedReport(
        "tabulations",
        getOrgIdOrThrow(),
        {
          from,
          to,
          actorUserIds,
          departmentIds,
          tabulationIds,
          page: Math.max(1, safePage),
          perPage: Math.min(100, Math.max(1, safePerPage)),
        },
        () =>
          timing.time("query", () =>
            getTabulationAnalytics({
              from,
              to,
              actorUserIds,
              departmentIds,
              actorUserId: actorUserIds[0] ?? null,
              departmentId: departmentIds[0] ?? null,
              tabulationIds,
              tabulationId: tabulationIds[0] ?? null,
              page: safePage,
              perPage: safePerPage,
            }),
          ),
        {
          onStatus: (status: ReportCacheStatus) =>
            timing.describeCache(
              new Map([["tabulations", status]]),
              performance.now() - cacheWaitStart,
            ),
        },
      );
      // Aditivo: só aparece quando o período foi cortado.
      return timedJson(timing, rangeClamped ? { ...data, rangeClamped: true } : data);
    } catch (e) {
      log.error({ err: e }, "[analytics/tabulations] falhou");
      // Rota restrita a gestor/admin: devolve a causa junto. Sem isso, a única
      // pista fica no log do container, e o painel some sem dizer por quê.
      return NextResponse.json(
        {
          message: "Erro ao carregar analytics de tabulações.",
          detail: e instanceof Error ? e.message : String(e),
        },
        { status: 500 },
      );
    }
  });
}
