/**
 * GET  /api/cron/replay-stuck-ai          dry-run
 * POST /api/cron/replay-stuck-ai?apply=1  dispara respostas
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * No container de prod (sem src/ nem tsx):
 *   curl -fsS "http://127.0.0.1:3000/api/cron/replay-stuck-ai?secret=$CRON_SECRET&hours=24"
 *   curl -fsS -X POST "http://127.0.0.1:3000/api/cron/replay-stuck-ai?secret=$CRON_SECRET&hours=24&apply=1"
 */

import { NextResponse } from "next/server";

import { replayStuckAiInbox } from "@/services/ai/replay-stuck-inbox";

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

function parseOpts(request: Request, applyDefault: boolean) {
  const url = new URL(request.url);
  const hours = Number.parseInt(url.searchParams.get("hours") ?? "24", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "80", 10);
  const apply =
    applyDefault ||
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  const numbers = (url.searchParams.get("numbers") ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const organizationId = url.searchParams.get("org")?.trim() || null;
  return { apply, hours, limit, numbers, organizationId };
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await replayStuckAiInbox(parseOpts(request, false));
    return NextResponse.json({ ...result, ok: true as const });
  } catch (e) {
    console.error("[cron/replay-stuck-ai]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no replay." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await replayStuckAiInbox(parseOpts(request, true));
    return NextResponse.json({ ...result, ok: true as const });
  } catch (e) {
    console.error("[cron/replay-stuck-ai]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no replay." },
      { status: 500 },
    );
  }
}
