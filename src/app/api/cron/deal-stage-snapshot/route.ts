/**
 * GET /api/cron/deal-stage-snapshot
 *
 * Grava o estoque OPEN por etapa (um ponto por dia civil America/Sao_Paulo).
 * Sem isso a evolução empilhada do Painel não existe.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 *
 * EasyPanel > Scheduled Service:
 *   Schedule: `5 3 * * *` (03:05 America/Sao_Paulo — ajuste o TZ do worker)
 *   Command:  curl -fsS "https://backend/api/cron/deal-stage-snapshot?secret=$CRON_SECRET"
 */

import { NextResponse } from "next/server";

import { recordDealStageSnapshots } from "@/services/painel-snapshots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
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
      return NextResponse.json({ ok: false, message: "Cron secret invalido." }, { status: 401 });
    }

    const result = await recordDealStageSnapshots();
    return NextResponse.json({ ok: true, ...result, retentionDays: 400 });
  } catch (e) {
    console.error("[cron/deal-stage-snapshot]", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no snapshot." },
      { status: 500 },
    );
  }
}
