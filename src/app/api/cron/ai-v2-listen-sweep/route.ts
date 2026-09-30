/**
 * GET  /api/cron/ai-v2-listen-sweep          dry-run (quantas escutas estão na vez)
 * POST /api/cron/ai-v2-listen-sweep          lê as conversas das escutas ligadas
 *
 * Rede de segurança do tick dos workers (`startListenSweeper`). Cada escuta
 * tem trava própria no banco: rodar junto com o tick não duplica leitura.
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 */

import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import { sweepAllListenSessions } from "@/services/ai-v2/listen";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: Request): NextResponse | null {
  return requireCronSecret(request);
}

async function handle(request: Request, apply: boolean) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const raw = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 20;
    return NextResponse.json({ ok: true, apply, ...(await sweepAllListenSessions({ limit, dryRun: !apply })) });
  } catch (e) {
    console.error("[cron/ai-v2-listen-sweep]", e);
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Erro na varredura." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request, false);
}

export async function POST(request: Request) {
  return handle(request, true);
}
