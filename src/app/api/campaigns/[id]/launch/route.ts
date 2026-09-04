import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { enqueueCampaignDispatch } from "@/lib/queue";

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

      const job = await enqueueCampaignDispatch({ campaignId: campaign.id }, delay);
      if (!job) {
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
  });
}
