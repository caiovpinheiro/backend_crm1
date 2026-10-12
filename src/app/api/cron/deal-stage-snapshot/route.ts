/**
 * GET /api/cron/deal-stage-snapshot
 *
 * Grava o estoque OPEN por etapa (um ponto por dia civil America/Sao_Paulo).
 * Sem isso a evolução empilhada do Painel não existe.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * Agendamento: o worker-meta-webhook já grava às 03:05 de São Paulo
 * (`services/deal-stage-snapshot-sweeper.ts`, `DEAL_STAGE_SNAPSHOT_WORKER=0`
 * desliga). Esta rota continua servindo para rodar à mão ou por agendador externo
 * — é idempotente (upsert por org + etapa + dia):
 *
 * EasyPanel > Scheduled Service (opcional):
 *   Schedule: `5 3 * * *` (03:05 America/Sao_Paulo — ajuste o TZ do worker)
 *   Command:  curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://backend/api/cron/deal-stage-snapshot"
 */

import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import { recordDealStageSnapshots } from "@/services/painel-snapshots";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/cron/deal-stage-snapshot");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const denied = requireCronSecret(request);
    if (denied) return denied;

    const result = await recordDealStageSnapshots();
    return NextResponse.json({ ok: true, ...result, retentionDays: 400 });
  } catch (e) {
    log.error({ err: e }, "[cron/deal-stage-snapshot] falhou");
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Erro no snapshot." },
      { status: 500 },
    );
  }
}
