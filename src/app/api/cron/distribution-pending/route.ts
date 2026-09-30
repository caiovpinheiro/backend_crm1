/**
 * GET /api/cron/distribution-pending
 *
 * Job de segurança: enfileira drenagem da fila "Aguardando distribuição"
 * (`worker-distribution` consome `distribution-drain`).
 * Não roda o scan na API.
 *
 * Cobre o 1º tick pós-deploy e passagens que ainda atribuem. Depois de
 * uma passagem vazia o cron devolve `{skipped:true,reason:cooldown}`
 * até `agent_online` / `agent_eligible` / `new_item` / `manual`.
 *
 * Autenticação: `Authorization: Bearer ${CRON_SECRET}` (`?secret=` ainda aceito, DEPRECADO — ver `requireCronSecret`).
 *
 * Como agendar (EasyPanel > Scheduled Service):
 *   Schedule: every 1 minute
 *   Command:  curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://BACKEND/api/cron/distribution-pending"
 *
 * Sem migration / sem tabela nova — só código.
 */

import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/auth/cron-secret";

import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import {
  enqueueProcessPendingOrRun,
  isFruitlessCooldownActiveAsync,
} from "@/services/distribution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const denied = requireCronSecret(request);
    if (denied) return denied;

    const orgs = await prismaBase.organizationWidget.findMany({
      where: { widgetSlug: "smart_distribution", status: "ACTIVE" },
      select: { organizationId: true },
      distinct: ["organizationId"],
    });

    const results: Array<{
      organizationId: string;
      resolved: number;
      pending: number;
    }> = [];
    let skippedCooldown = 0;

    for (const { organizationId } of orgs) {
      if (await isFruitlessCooldownActiveAsync(organizationId)) {
        skippedCooldown += 1;
        continue;
      }
      try {
        const drain = await runWithContext(
          {
            organizationId,
            userId: "system",
            isSuperAdmin: false,
            actor: {
              type: "SYSTEM",
              label: "Distribuição Inteligente",
              sublabel: "cron:distribution-pending",
            },
          },
          () => enqueueProcessPendingOrRun({ trigger: "scheduled" }),
        );
        if (drain.skipReason === "COOLDOWN") {
          skippedCooldown += 1;
          continue;
        }
        results.push({
          organizationId,
          resolved: drain.resolved,
          pending: drain.pending,
        });
      } catch (e) {
        console.error(
          "[cron/distribution-pending] org failed",
          organizationId,
          e,
        );
        results.push({ organizationId, resolved: 0, pending: -1 });
      }
    }

    if (orgs.length > 0 && skippedCooldown === orgs.length) {
      console.info(
        "[cron/distribution-pending] skipped",
        JSON.stringify({ reason: "cooldown", orgs: orgs.length }),
      );
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "cooldown",
        orgs: orgs.length,
        resolvedTotal: 0,
      });
    }

    const resolvedTotal = results.reduce((s, r) => s + Math.max(0, r.resolved), 0);

    return NextResponse.json({
      ok: true,
      orgs: orgs.length,
      resolvedTotal,
      skippedCooldown,
      results,
    });
  } catch (e) {
    console.error("[cron/distribution-pending]", e);
    return NextResponse.json(
      { ok: false, message: "Erro no cron de distribuição." },
      { status: 500 },
    );
  }
}
