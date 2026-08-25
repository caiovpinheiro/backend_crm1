import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueCampaignSend } from "@/lib/queue";
import { isCampaignSendRoundRobinEnabled } from "@/lib/campaign-send-rate";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { status: true },
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

    await prisma.campaign.update({
      where: { id },
      data: { status: "SENDING" },
    });

    if (isCampaignSendRoundRobinEnabled()) {
      // O loop de rodízio descobre os PENDING direto no banco — enfileirar
      // seria redundante (a fila campaign-send não tem consumidor neste modo).
      const pending = await prisma.campaignRecipient.count({
        where: { campaignId: id, status: "PENDING" },
      });
      return NextResponse.json({
        message: `Campanha retomada. ${pending} envios pendentes serão retomados automaticamente.`,
        status: "SENDING",
      });
    }

    const pendingRecipients = await prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: "PENDING" },
      include: {
        contact: { select: { id: true, phone: true, whatsappBsuid: true } },
      },
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
}
