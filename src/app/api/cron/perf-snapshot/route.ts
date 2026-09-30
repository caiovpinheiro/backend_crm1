/**
 * GET /api/cron/perf-snapshot
 *
 * Gera um snapshot do perf-report e grava em disco (JSON + Markdown) sob
 * `STORAGE_ROOT/perf-reports/<env>/<timestamp>.{json,md}` — apartado dos
 * bancos da aplicacao. Serve como historico versionavel de performance
 * para consumo por IA (revisao de tendencia) e auditoria.
 *
 * Autenticacao: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * Como agendar (EasyPanel > Scheduled Service):
 *   Schedule: `0 * * * *` (a cada hora)
 *   Command:  curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://backend/api/cron/perf-snapshot"
 *
 * Params opcionais:
 *   ?windowMinutes=60    janela de agregacao (default 60)
 *   ?keep=168            manter apenas os N snapshots mais recentes (default 168 = 7d/1h)
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { requireCronSecret } from "@/lib/auth/cron-secret";
import { buildPerfReport, renderReportMarkdown } from "@/lib/perf/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function storageRoot(): string {
  return process.env.STORAGE_ROOT?.trim() || "/app/storage";
}

function envLabel(): string {
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

export async function GET(request: Request) {
  try {
    const denied = requireCronSecret(request);
    if (denied) return denied;

    const url = new URL(request.url);

    const windowMinutes = clamp(Number(url.searchParams.get("windowMinutes") ?? "60"), 5, 720, 60);
    const keep = clamp(Number(url.searchParams.get("keep") ?? "168"), 1, 10_000, 168);

    const report = await buildPerfReport({ windowMinutes });
    const md = renderReportMarkdown(report);

    const dir = path.join(storageRoot(), "perf-reports", envLabel());
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date(report.generatedAt).toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `${ts}.json`);
    const mdPath = path.join(dir, `${ts}.md`);

    await Promise.all([
      fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8"),
      fs.writeFile(mdPath, md, "utf8"),
    ]);

    // Rotacao: mantem apenas os `keep` mais recentes (par json/md).
    const rotated = await rotate(dir, keep);

    return NextResponse.json({
      ok: true,
      files: { json: jsonPath, md: mdPath },
      recommendationsCount: report.recommendations.length,
      rotated,
    });
  } catch (e) {
    console.error("[cron/perf-snapshot]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no snapshot." },
      { status: 500 },
    );
  }
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function rotate(dir: string, keep: number): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    const jsons = entries.filter((f) => f.endsWith(".json")).sort();
    const excess = jsons.length - keep;
    if (excess <= 0) return 0;
    const toDelete = jsons.slice(0, excess);
    await Promise.all(
      toDelete.flatMap((name) => {
        const base = name.replace(/\.json$/, "");
        return [
          fs.unlink(path.join(dir, `${base}.json`)).catch(() => undefined),
          fs.unlink(path.join(dir, `${base}.md`)).catch(() => undefined),
        ];
      }),
    );
    return toDelete.length;
  } catch {
    return 0;
  }
}
