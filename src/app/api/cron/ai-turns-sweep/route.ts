/**
 * GET  /api/cron/ai-turns-sweep          dry-run (conta o que faria)
 * POST /api/cron/ai-turns-sweep?apply=1  executa o tick
 *
 * Rede de segurança externa do Turn Manager. O tick in-process
 * (`startAiTurnSweeper`) já roda na API e nos workers de ingestão; esta
 * rota existe para o caso em que TODOS eles estejam mortos ou a flag
 * tenha subido só depois de os turnos serem criados. Como todo o estado
 * está no banco, o cron sozinho é suficiente para drenar a fila.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * No container de prod:
 *   curl -fsS "http://127.0.0.1:3000/api/cron/ai-turns-sweep?secret=$CRON_SECRET"
 *   curl -fsS -X POST "http://127.0.0.1:3000/api/cron/ai-turns-sweep?secret=$CRON_SECRET&apply=1"
 */

import { NextResponse } from "next/server";

import { isTurnManagerEnabled } from "@/services/ai/turn-manager";
import { sweepConversationTurns } from "@/services/ai/turn-sweeper";

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

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 50;
}

async function handle(request: Request, apply: boolean) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await sweepConversationTurns({
      limit: parseLimit(request),
      dryRun: !apply,
    });
    return NextResponse.json({
      ok: true,
      enabled: isTurnManagerEnabled(),
      apply,
      ...result,
    });
  } catch (e) {
    console.error("[cron/ai-turns-sweep]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro na varredura." },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const apply =
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  return handle(request, apply);
}

export async function POST(request: Request) {
  return handle(request, true);
}
