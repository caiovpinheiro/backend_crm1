/**
 * GET  /api/cron/replay-stuck-ai          dry-run
 * POST /api/cron/replay-stuck-ai?apply=1  dispara respostas
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * No container de prod (sem src/ nem tsx):
 *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3000/api/cron/replay-stuck-ai?hours=24"
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3000/api/cron/replay-stuck-ai?hours=24&apply=1"
 */

import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import { replayStuckAiInbox } from "@/services/ai/replay-stuck-inbox";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/cron/replay-stuck-ai");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: Request): NextResponse | null {
  return requireCronSecret(request);
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
    log.error({ err: e }, "[cron/replay-stuck-ai] falhou");
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
    log.error({ err: e }, "[cron/replay-stuck-ai] falhou");
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no replay." },
      { status: 500 },
    );
  }
}
