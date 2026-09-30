/**
 * GET  /api/cron/sweep-finished-ai          dry-run (lista candidatos)
 * POST /api/cron/sweep-finished-ai?apply=1  encerra os tickets
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * No container de prod (sem src/ nem tsx):
 *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3000/api/cron/sweep-finished-ai?hours=72"
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3000/api/cron/sweep-finished-ai?hours=72&apply=1"
 */

import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import { sweepFinishedAiConversations } from "@/services/ai/sweep-finished-ai-conversations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: Request): NextResponse | null {
  return requireCronSecret(request);
}

function parseOpts(request: Request, applyDefault: boolean) {
  const url = new URL(request.url);
  const hours = Number.parseInt(url.searchParams.get("hours") ?? "72", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
  const quietMinutes = Number.parseInt(
    url.searchParams.get("quietMinutes") ?? "10",
    10,
  );
  const apply =
    applyDefault ||
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  const numbers = (url.searchParams.get("numbers") ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const organizationId = url.searchParams.get("org")?.trim() || null;
  return {
    apply,
    hours: Number.isFinite(hours) ? hours : 72,
    limit: Number.isFinite(limit) ? limit : 200,
    quietMinutes: Number.isFinite(quietMinutes) ? quietMinutes : 10,
    numbers,
    organizationId,
  };
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await sweepFinishedAiConversations(parseOpts(request, false));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/sweep-finished-ai]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro na varredura." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await sweepFinishedAiConversations(parseOpts(request, true));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/sweep-finished-ai]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro na varredura." },
      { status: 500 },
    );
  }
}
