import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getCampaigns, createCampaign, type CreateCampaignInput } from "@/services/campaigns";

const CAMPAIGN_TYPES = new Set(["TEMPLATE", "TEXT", "AUTOMATION"]);

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:view");
    if (denied) return denied;
    try {
      const { searchParams } = new URL(request.url);
      const result = await getCampaigns({
        status: (searchParams.get("status") as never) ?? undefined,
        type: (searchParams.get("type") as never) ?? undefined,
        search: searchParams.get("search")?.trim() || undefined,
        page: Number(searchParams.get("page")) || 1,
        perPage: Number(searchParams.get("perPage")) || 20,
      });

      return NextResponse.json(result);
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao listar campanhas." },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:create");
    if (denied) return denied;
    try {
      const body = (await request.json()) as Record<string, unknown>;

      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
      }

      const type = typeof body.type === "string" ? body.type : "";
      if (!CAMPAIGN_TYPES.has(type)) {
        return NextResponse.json({ message: "Tipo de campanha inválido." }, { status: 400 });
      }

      const useLastConversationChannel = body.useLastConversationChannel === true;
      const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
      if (!useLastConversationChannel && !channelId) {
        return NextResponse.json({ message: "Canal é obrigatório." }, { status: 400 });
      }

      const input: CreateCampaignInput = {
        name,
        type: type as CreateCampaignInput["type"],
        channelId: useLastConversationChannel ? null : channelId,
        useLastConversationChannel,
        createdById: session.user.id,
        segmentId: typeof body.segmentId === "string" ? body.segmentId : undefined,
        filters: body.filters as never,
        templateName: typeof body.templateName === "string" ? body.templateName : undefined,
        templateLanguage: typeof body.templateLanguage === "string" ? body.templateLanguage : undefined,
        templateComponents: body.templateComponents ?? undefined,
        textContent: typeof body.textContent === "string" ? body.textContent : undefined,
        automationId: typeof body.automationId === "string" ? body.automationId : undefined,
        sendRate: typeof body.sendRate === "number" ? body.sendRate : undefined,
        scheduledAt: typeof body.scheduledAt === "string" ? new Date(body.scheduledAt) : undefined,
      };

      const campaign = await createCampaign(input);
      return NextResponse.json({ campaign }, { status: 201 });
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao criar campanha." },
        { status: 500 },
      );
    }
  });
}
