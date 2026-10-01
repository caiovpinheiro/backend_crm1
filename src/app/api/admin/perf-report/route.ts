/**
 * GET /api/admin/perf-report — relatorio consolidado de performance.
 *
 * Super-admin only. Consulta o Prometheus (via PROMETHEUS_URL) e o pg
 * local para produzir um JSON versionado (`schemaVersion`) com metricas
 * de CPU/mem/disco/IO por container, uso de banco, API e filas, alem de
 * uma lista de `recommendations[]` maquina-legivel (somente leitura).
 *
 * Uso:
 *   GET /api/admin/perf-report?windowMinutes=60&format=json|md
 *
 * Query params:
 *   windowMinutes — janela de agregacao (default 60, min 5, max 720).
 *   format        — "json" (default) ou "md" (markdown).
 */

import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/auth-helpers";
import { buildPerfReport, renderReportMarkdown } from "@/lib/perf/report";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/admin/perf-report");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireSuperAdmin();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawWindow = Number(url.searchParams.get("windowMinutes") ?? "60");
  const windowMinutes = Math.min(720, Math.max(5, Number.isFinite(rawWindow) ? rawWindow : 60));
  const format = url.searchParams.get("format") === "md" ? "md" : "json";

  try {
    const report = await buildPerfReport({ windowMinutes });
    if (format === "md") {
      return new NextResponse(renderReportMarkdown(report), {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(report, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    log.error({ err }, "[admin/perf-report GET] falhou");
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Falha ao gerar perf-report." },
      { status: 500 },
    );
  }
}
