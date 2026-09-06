/**
 * GET  /api/cron/db-retention          dry-run (conta candidatos, não apaga)
 * POST /api/cron/db-retention?apply=1  apaga em lotes
 *
 * Retenção das tabelas-log sem TTL: meta_webhook_events (21d),
 * ai_agent_runs + automation_logs + distribution_logs (120d). Janelas via
 * env (ver src/services/db-retention.ts). `?only=meta_webhook_events,...`
 * restringe a alvos específicos.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * Agendar externo (1x/dia basta):
 *   curl -fsS "http://127.0.0.1:3000/api/cron/db-retention?secret=$CRON_SECRET"
 *   curl -fsS -X POST "http://127.0.0.1:3000/api/cron/db-retention?secret=$CRON_SECRET&apply=1"
 */

import { NextResponse } from "next/server";

import { runDbRetention } from "@/services/db-retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, message: "CRON_SECRET nao configurado." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const headerSecret = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const provided = headerSecret || (url.searchParams.get("secret")?.trim() ?? "");
  if (!provided || provided !== expected) {
    return NextResponse.json(
      { ok: false, message: "Cron secret invalido." },
      { status: 401 },
    );
  }
  return null;
}

function parseOnly(request: Request): string[] | undefined {
  const raw = new URL(request.url).searchParams.get("only")?.trim();
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

async function handle(request: Request, apply: boolean) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await runDbRetention({ apply, only: parseOnly(request) });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/db-retention]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro na retenção." },
      { status: 500 },
    );
  }
}

export function GET(request: Request) {
  return handle(request, false);
}

export function POST(request: Request) {
  return handle(request, true);
}
