import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueCampaignDispatch } from "@/lib/queue";

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
      include: { channel: { select: { status: true } } },
    });

    if (!campaign) {
      return NextResponse.json({ message: "Campanha não encontrada." }, { status: 404 });
    }

    if (campaign.status !== "DRAFT") {
      return NextResponse.json(
        { message: "Apenas campanhas em rascunho podem ser lançadas." },
        { status: 409 },
      );
    }

    if (!campaign.useLastConversationChannel) {
      if (!campaign.channelId || !campaign.channel) {
        return NextResponse.json(
          { message: "Canal é obrigatório para campanha com canal fixo." },
          { status: 400 },
        );
      }
      if (campaign.channel.status !== "CONNECTED") {
        return NextResponse.json(
          { message: "O canal selecionado não está conectado." },
          { status: 409 },
        );
      }
    }

    if (!campaign.segmentId && !campaign.filters) {
      return NextResponse.json(
        { message: "Selecione um segmento ou configure filtros de destinatários." },
        { status: 400 },
      );
    }

    if (campaign.type === "TEMPLATE" && !campaign.templateName) {
      return NextResponse.json(
        { message: "Selecione um template para campanha do tipo Template." },
        { status: 400 },
      );
    }

    if (campaign.type === "TEXT" && !campaign.textContent) {
      return NextResponse.json(
        { message: "Insira o conteúdo da mensagem para campanha do tipo Texto." },
        { status: 400 },
      );
    }

    if (campaign.type === "AUTOMATION" && !campaign.automationId) {
      return NextResponse.json(
        { message: "Selecione uma automação para campanha do tipo Automação." },
        { status: 400 },
      );
    }

    const isScheduled = campaign.scheduledAt && campaign.scheduledAt > new Date();
    const newStatus = isScheduled ? "SCHEDULED" : "PROCESSING";
    const delay = isScheduled
      ? campaign.scheduledAt!.getTime() - Date.now()
      : undefined;

    await prisma.campaign.update({
      where: { id },
      data: { status: newStatus },
    });

    // `id` pode ser o `number` público (ex.: "32") — o prisma escopado resolve
    // number→id na leitura acima, mas o worker consome via prismaBase (sem essa
    // extensão) e só acha pelo cuid. Enfileirar o id real evita "Campaign N não
    // encontrada" e campanha presa em PROCESSING.
    const job = await enqueueCampaignDispatch({ campaignId: campaign.id }, delay);
    if (!job) {
      // Redis indisponível: o enqueue retorna null em silêncio. Reverter o
      // status para DRAFT em vez de deixar a campanha presa em PROCESSING/
      // SCHEDULED sem nenhum worker para consumir o job.
      await prisma.campaign.update({
        where: { id },
        data: { status: "DRAFT" },
      });
      return NextResponse.json(
        {
          message:
            "Fila de disparo indisponível (Redis). A campanha continua como rascunho — tente lançar novamente em instantes.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      message: isScheduled
        ? `Campanha agendada para ${campaign.scheduledAt!.toLocaleString("pt-BR")}.`
        : "Campanha iniciada.",
      status: newStatus,
    });
  } catch (e: unknown) {
    console.error(e);
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao lançar campanha." },
      { status: 500 },
    );
  }
}
