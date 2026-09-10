import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { enqueueCampaignSend } from "@/lib/queue";
import { isCampaignSendRoundRobinEnabled } from "@/lib/campaign-send-rate";
import { nextCampaignSendCap } from "@/lib/campaign-send-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:send");
    if (denied) return denied;
    try {
      const { id } = await params;

      const campaign = await prisma.campaign.findUnique({
        where: { id },
        select: {
          status: true,
          sendLimit: true,
          sentCount: true,
          failedCount: true,
        },
      });

      if (!campaign) {
        return NextResponse.json({ message: "Campanha não encontrada." }, { status: 404 });
      }

      if (campaign.status !== "PAUSED") {
        return NextResponse.json(
          { message: "Apenas campanhas pausadas podem ser retomadas." },
          { status: 409 },
        );
      }

      // Trava por lote: cada retomada libera outro lote de `sendLimit`.
      const sendCap = campaign.sendLimit
        ? nextCampaignSendCap(
            campaign.sentCount + campaign.failedCount,
            campaign.sendLimit,
          )
        : null;

      await prisma.campaign.update({
        where: { id },
        data: { status: "SENDING", sendCap },
      });

      if (isCampaignSendRoundRobinEnabled()) {
        const pending = await prisma.campaignRecipient.count({
          where: { campaignId: id, status: "PENDING" },
        });
        const batch = campaign.sendLimit
          ? Math.min(campaign.sendLimit, pending)
          : pending;
        return NextResponse.json({
          message: campaign.sendLimit
            ? `Campanha retomada. Próximo lote de ${batch} envios (${pending} pendentes no total).`
            : `Campanha retomada. ${pending} envios pendentes serão retomados automaticamente.`,
          status: "SENDING",
        });
      }

      const pendingRecipients = await prisma.campaignRecipient.findMany({
        where: { campaignId: id, status: "PENDING" },
        include: {
          contact: { select: { id: true, phone: true, whatsappBsuid: true } },
        },
        // Caminho FIFO (rollback do rodízio): enfileirar só o lote. A trava
        // ainda pausa via contadores, mas sem isto a fila levaria a audiência
        // inteira e o resto só seria descartado no consumo.
        ...(campaign.sendLimit ? { take: campaign.sendLimit } : {}),
      });

      for (const r of pendingRecipients) {
        if (!r.contact.phone) continue;
        await enqueueCampaignSend({
          campaignId: id,
          recipientId: r.id,
          contactId: r.contactId,
          contactPhone: r.contact.phone,
          contactBsuid: r.contact.whatsappBsuid ?? undefined,
        });
      }

      return NextResponse.json({
        message: `Campanha retomada. ${pendingRecipients.length} envios na fila.`,
        status: "SENDING",
      });
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao retomar campanha." },
        { status: 500 },
      );
    }
  });
}
