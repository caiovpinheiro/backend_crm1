/**
 * GET  /api/cron/retry-unanswered-ai          dry-run (lista candidatos)
 * POST /api/cron/retry-unanswered-ai?apply=1  faz a IA responder
 *
 * Conversas na aba do Agente IA em que a última mensagem é do aluno e
 * ninguém respondeu. O worker de inatividade já roda isso a cada minuto;
 * esta rota serve pra rodar na hora, com janela/limite maiores.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * No container de prod (sem src/ nem tsx):
 *   curl -fsS "http://127.0.0.1:3000/api/cron/retry-unanswered-ai?secret=$CRON_SECRET&minutes=3"
 *   curl -fsS -X POST "http://127.0.0.1:3000/api/cron/retry-unanswered-ai?secret=$CRON_SECRET&minutes=3&limit=200&apply=1"
 */

import { NextResponse } from "next/server";

import { retryUnansweredAiInbound } from "@/services/ai/retry-unanswered-ai-inbound";

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
  const minutes = Number.parseInt(url.searchParams.get("minutes") ?? "3", 10);
  const hours = Number.parseInt(url.searchParams.get("hours") ?? "24", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const apply =
    applyDefault ||
    url.searchParams.get("apply") === "1" ||
    url.searchParams.get("apply") === "true";
  const numbers = (url.searchParams.get("numbers") ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    apply,
    retryMs: (Number.isFinite(minutes) ? minutes : 3) * 60_000,
    maxAgeMs: (Number.isFinite(hours) ? hours : 24) * 60 * 60_000,
    limit: Number.isFinite(limit) ? limit : 100,
    numbers,
    organizationId: url.searchParams.get("org")?.trim() || null,
    force: url.searchParams.get("force") === "1",
  };
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  try {
    const result = await retryUnansweredAiInbound(parseOpts(request, false));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/retry-unanswered-ai]", e);
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
    const result = await retryUnansweredAiInbound(parseOpts(request, true));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/retry-unanswered-ai]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro na varredura." },
      { status: 500 },
    );
  }
}
