import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import { syncMetaPricing } from "@/services/meta-pricing-sync";

/**
 * GET /api/cron/sync-meta-pricing
 *
 * Endpoint chamado por agendador externo (Easypanel scheduler, cron
 * de servidor, etc). NAO usa sessao — autentica via header
 * `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * Sincroniza os ULTIMOS 7 DIAS por padrao (a Meta pode reprocessar
 * dados recentes — repetir o sync rolling cobre eventuais ajustes
 * sem precisar buscar tudo de novo).
 *
 * Como agendar (Easypanel):
 *   - Add Service > Scheduled
 *   - Schedule: `0 6 * * *` (06:00 UTC = 03:00 BRT)
 *   - Command: `curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://crm.eduit.com.br/api/cron/sync-meta-pricing"`
 */
export async function GET(request: Request) {
  try {
    const denied = requireCronSecret(request);
    if (denied) return denied;

    const url = new URL(request.url);

    // Janela: ultimos 7 dias por padrao, sobrescritivel via ?days=
    const daysParam = Number(url.searchParams.get("days") ?? "7");
    const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 90
      ? Math.floor(daysParam)
      : 7;

    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const to = new Date(now);
    to.setUTCHours(23, 59, 59, 999);

    const result = await syncMetaPricing({ from, to });

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    console.error("[cron/sync-meta-pricing]", e);
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Erro no cron de sync.",
      },
      { status: 500 },
    );
  }
}
