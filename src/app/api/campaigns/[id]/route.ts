import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getCampaignById, updateCampaign, deleteCampaign } from "@/services/campaigns";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;
    const campaign = await getCampaignById(id);
    if (!campaign) {
      return NextResponse.json({ message: "Campanha não encontrada." }, { status: 404 });
    }
    return NextResponse.json({ campaign });
  } catch (e: unknown) {
    console.error(e);
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao buscar campanha." },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string") data.name = body.name.trim();
    if (typeof body.type === "string") data.type = body.type;
    if (typeof body.channelId === "string") data.channelId = body.channelId;
    if (typeof body.useLastConversationChannel === "boolean") {
      data.useLastConversationChannel = body.useLastConversationChannel;
    }
    if (typeof body.segmentId === "string") data.segmentId = body.segmentId;
    if (body.filters !== undefined) data.filters = body.filters;
    if (typeof body.templateName === "string") data.templateName = body.templateName;
    if (typeof body.templateLanguage === "string") data.templateLanguage = body.templateLanguage;
    if (body.templateComponents !== undefined) data.templateComponents = body.templateComponents;
    if (typeof body.textContent === "string") data.textContent = body.textContent;
    if (typeof body.automationId === "string") data.automationId = body.automationId;
    if (typeof body.sendRate === "number") data.sendRate = body.sendRate;
    if (typeof body.scheduledAt === "string") data.scheduledAt = new Date(body.scheduledAt);

    const campaign = await updateCampaign(id, data as never);
    return NextResponse.json({ campaign });
  } catch (e: unknown) {
    console.error(e);
    const status = (e instanceof Error && e.message.includes("rascunho")) ? 409 : 500;
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao atualizar campanha." },
      { status },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await params;
    await deleteCampaign(id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error(e);
    const status = (e instanceof Error && e.message.includes("ativa")) ? 409 : 500;
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao excluir campanha." },
      { status },
    );
  }
}
