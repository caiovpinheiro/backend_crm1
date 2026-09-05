import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  campaignRecipientPhones,
  campaignRecipientsToCsv,
  getCampaignById,
  listCampaignRecipientsForExport,
} from "@/services/campaigns";

function slugPart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .toLowerCase();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "campaign:view");
    if (denied) return denied;
    try {
      const { id } = await params;
      const campaign = await getCampaignById(id);
      if (!campaign) {
        return NextResponse.json({ message: "Campanha não encontrada." }, { status: 404 });
      }

      const { searchParams } = new URL(request.url);
      const status = searchParams.get("status") ?? "FAILED";
      const errorCode = searchParams.get("errorCode");
      const format = (searchParams.get("format") ?? "csv").toLowerCase();

      const rows = await listCampaignRecipientsForExport({
        campaignId: campaign.id,
        status,
        errorCode,
      });

      const codePart = errorCode?.trim() ? `-${slugPart(errorCode)}` : "";
      const base = `campanha-${campaign.number ?? slugPart(campaign.name) || campaign.id}-falhas${codePart}`;

      if (format === "phones") {
        const body = campaignRecipientPhones(rows);
        return new NextResponse(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${base}-telefones.txt"`,
            "X-Export-Total": String(rows.length),
          },
        });
      }

      const csv = `\uFEFF${campaignRecipientsToCsv(rows)}`;
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${base}.csv"`,
          "X-Export-Total": String(rows.length),
        },
      });
    } catch (e: unknown) {
      console.error(e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao exportar destinatários." },
        { status: 500 },
      );
    }
  });
}
