/**
 * GET  /api/cron/distribute-stuck-inbound          dry-run (só lista)
 * POST /api/cron/distribute-stuck-inbound?apply=1  distribui de fato
 *
 * Destrava aluno preso na IA: conversa OPEN, responsável do tipo AI, sem
 * resposta humana e sem nenhuma outbound depois do último inbound. NÃO
 * envia mensagem ao aluno — só reatribui / enfileira na Distribuição.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * Parâmetros:
 *   minMinutes=15   idle mínimo (alias em ms: `stuckMs`)
 *   sinceMinutes=0  janela: só inbound das últimas N min (0 = sem limite)
 *   limit=50        teto de conversas por execução (máx. 500)
 *   org=<id>        restringe a uma organização
 *
 * No container de prod (sem src/ nem tsx):
 *   curl -fsS "http://127.0.0.1:3000/api/cron/distribute-stuck-inbound?secret=$CRON_SECRET&minMinutes=15&limit=200"
 *   curl -fsS -X POST "http://127.0.0.1:3000/api/cron/distribute-stuck-inbound?secret=$CRON_SECRET&minMinutes=15&limit=200&apply=1"
 */

import { NextResponse } from "next/server";

import {
  STUCK_INBOUND_MS,
  distributeStuckInbound,
  type StuckInboundOptions,
} from "@/services/ai/stuck-inbound-distribution";

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

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseOpts(
  request: Request,
  applyDefault: boolean,
): StuckInboundOptions {
  const url = new URL(request.url);
  const stuckMs = intParam(
    url,
    "stuckMs",
    intParam(url, "minMinutes", STUCK_INBOUND_MS / 60_000) * 60_000,
  );
  const apply =
    applyDefault ||
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  return {
    apply,
    stuckMs,
    sinceMs: intParam(url, "sinceMinutes", 0) * 60_000,
    limit: intParam(url, "limit", 50),
    organizationId: url.searchParams.get("org")?.trim() || null,
  };
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await distributeStuckInbound(parseOpts(request, false));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/distribute-stuck-inbound]", e);
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Erro na distribuicao.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await distributeStuckInbound(parseOpts(request, true));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/distribute-stuck-inbound]", e);
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Erro na distribuicao.",
      },
      { status: 500 },
    );
  }
}
