/**
 * GET /api/cron/distribution-pending
 *
 * Legado EasyPanel (every 1 minute). A espera da Inteligente não é mais
 * varrida por este endpoint: drena por evento (`agent_online` /
 * `agent_eligible` / `capacity_released` / `new_item` / `manual`) e por
 * um job BullMQ atrasado no próximo expediente (`hours_open`).
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` ou `?secret=`.
 * Resposta estável para o scheduler não 404: `{ skipped: true, reason:
 * "event_driven" }` — sem Prisma, sem Redis, sem enqueue.
 */

import { NextResponse } from "next/server";

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
    const provided =
      headerSecret || (url.searchParams.get("secret")?.trim() ?? "");
    if (!provided || provided !== expected) {
      return NextResponse.json(
        { ok: false, message: "Cron secret invalido." },
        { status: 401 },
      );
    }

    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "event_driven",
      resolvedTotal: 0,
    });
  } catch (e) {
    console.error("[cron/distribution-pending]", e);
    return NextResponse.json(
      { ok: false, message: "Erro no cron de distribuição." },
      { status: 500 },
    );
  }
}
