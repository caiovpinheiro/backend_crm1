import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { syncMetaPricing } from "@/services/meta-pricing-sync";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/reports/messaging/sync");

/**
 * POST /api/reports/messaging/sync
 *
 * Forca uma sincronizacao do cache MetaPricingDailyMetric com a
 * Graph API da Meta. Aceita { from, to } no body (ISO date string)
 * ou usa "ultimos 30 dias" como default.
 *
 * Endpoint pesado (chama Graph), por isso fica em rota separada e
 * exige sessao. Cron usa /api/cron/sync-meta-pricing (protegido por
 * CRON_SECRET, sem sessao).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    let body: { from?: string; to?: string } = {};
    try {
      body = (await request.json()) as { from?: string; to?: string };
    } catch {
      // body vazio = usa defaults
    }

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = body.from ? new Date(body.from) : defaultFrom;
    const to = body.to ? new Date(body.to) : now;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json(
        { message: "Datas invalidas. Use ISO 8601." },
        { status: 400 },
      );
    }
    if (from >= to) {
      return NextResponse.json(
        { message: "`from` precisa ser anterior a `to`." },
        { status: 400 },
      );
    }

    // Estende o `to` ate o fim do dia (a Meta processa por bucket
    // diario completo — se passarmos "hoje 10h" perdemos os dados
    // de 10h-23:59).
    const endOfDay = new Date(to);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const result = await syncMetaPricing({ from, to: endOfDay });

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    log.error({ err: e }, "[reports/messaging/sync] falhou");
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Erro ao sincronizar com a Meta.",
      },
      { status: 500 },
    );
  }
}
