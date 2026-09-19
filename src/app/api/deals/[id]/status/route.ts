import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrgSettingBool } from "@/lib/org-settings";
import { fireTrigger, notifyDealStageChanged } from "@/services/automation-triggers";
import {
  createDealEventTx,
  getDealById,
  markDealLostTx,
  validateMarkDealLost,
  markDealWonTx,
  reopenDealTx,
} from "@/services/deals";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    if (b.status !== "WON" && b.status !== "LOST" && b.status !== "OPEN") {
      return NextResponse.json(
        { message: "status deve ser WON, LOST ou OPEN." },
        { status: 400 }
      );
    }

    const existing = await getDealById(id);
    if (!existing) {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }

    const dealId = existing.id;

    try {
      const uid = (session.user as { id: string }).id;
      const fromStatus = existing.status;
      const fromStageId = existing.stageId;
      const fromPipelineId = (existing.stage as { pipelineId?: string } | undefined)?.pipelineId ?? null;

      if (b.status === "WON") {
        const deal = await prisma.$transaction(async (tx) => {
          const updated = await markDealWonTx(tx, dealId);
          await createDealEventTx(tx, dealId, uid, "STATUS_CHANGED", {
            from: fromStatus,
            to: "WON",
          });
          if (updated.stageId !== fromStageId) {
            await createDealEventTx(tx, dealId, uid, "STAGE_CHANGED", {
              from: { id: fromStageId, pipelineId: fromPipelineId },
              to: {
                id: updated.stageId,
                pipelineId: updated.stage?.pipelineId ?? null,
              },
            });
          }
          return updated;
        });
        fireTrigger("deal_won", { dealId, contactId: existing.contactId ?? undefined, data: { fromStatus } }).catch(() => {});
        notifyDealStageChanged(dealId, fromStageId, deal.stageId, { contactId: existing.contactId ?? undefined }).catch(() => {});
        return NextResponse.json(deal);
      }

      if (b.status === "LOST") {
        const reason = typeof b.lostReason === "string" ? b.lostReason.trim() : "";
        const required = await getOrgSettingBool("deals.loss_reason_required", false).catch(() => false);
        if ((required || !reason) && !reason) {
          return NextResponse.json(
            { message: "lostReason é obrigatório quando status é LOST." },
            { status: 400 }
          );
        }
        // Validação do motivo de perda fica fora da transação (depende de settings).
        await validateMarkDealLost(dealId, reason);
        const deal = await prisma.$transaction(async (tx) => {
          const updated = await markDealLostTx(tx, dealId, reason);
          await createDealEventTx(tx, dealId, uid, "STATUS_CHANGED", {
            from: fromStatus,
            to: "LOST",
            lostReason: reason,
          });
          if (updated.stageId !== fromStageId) {
            await createDealEventTx(tx, dealId, uid, "STAGE_CHANGED", {
              from: { id: fromStageId, pipelineId: fromPipelineId },
              to: {
                id: updated.stageId,
                pipelineId: updated.stage?.pipelineId ?? null,
              },
            });
          }
          return updated;
        });
        fireTrigger("deal_lost", { dealId, contactId: existing.contactId ?? undefined, data: { fromStatus, lostReason: reason } }).catch(() => {});
        notifyDealStageChanged(dealId, fromStageId, deal.stageId, { contactId: existing.contactId ?? undefined }).catch(() => {});
        return NextResponse.json(deal);
      }

      // Reabrir: status volta para OPEN; stage permanece o mesmo.
      const deal = await prisma.$transaction(async (tx) => {
        const updated = await reopenDealTx(tx, dealId);
        await createDealEventTx(tx, dealId, uid, "STATUS_CHANGED", {
          from: fromStatus,
          to: "OPEN",
        });
        return updated;
      });
      notifyDealStageChanged(dealId, fromStageId, deal.stageId, { contactId: existing.contactId ?? undefined }).catch(() => {});
      return NextResponse.json(deal);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "LOST_REASON_REQUIRED") {
        return NextResponse.json(
          { message: "Motivo da perda é obrigatório neste funil." },
          { status: 400 },
        );
      }
      if (err instanceof Error && err.message === "INVALID_LOST_REASON") {
        return NextResponse.json(
          {
            message:
              "Motivo da perda inválido. Selecione um dos motivos cadastrados em Configurações → Motivos de perda.",
          },
          { status: 400 },
        );
      }
      throw err;
    }
  } catch (e: unknown) {
    console.error(e);
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }
    return NextResponse.json({ message: "Erro ao alterar status do negócio." }, { status: 500 });
  }
}
