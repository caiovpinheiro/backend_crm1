import { NextResponse } from "next/server";

import { campaignNotFound, withIntegrationsApi } from "@/lib/integrations-api";
import { extractMetaErrorCode } from "@/lib/meta-whatsapp/error-catalog";
import { prisma } from "@/lib/prisma";
import { getCampaignRecipients } from "@/services/campaigns";

const RECIPIENT_STATUSES = new Set([
  "PENDING",
  "SENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
]);

/**
 * Destinatários da campanha, com filtro por `status` e por `errorCode`
 * (código numérico da Meta ou `other`). Filtro inválido é recusado em vez de
 * ser ignorado (o serviço devolveria a lista inteira).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withIntegrationsApi(request, "campaign:view", async () => {
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    const status = searchParams.get("status")?.trim() || undefined;
    if (status && !RECIPIENT_STATUSES.has(status)) {
      return NextResponse.json(
        { message: `status inválido. Use: ${[...RECIPIENT_STATUSES].join(", ")}.` },
        { status: 400 },
      );
    }
    const errorCode = searchParams.get("errorCode")?.trim() || undefined;
    if (errorCode && errorCode !== "other" && !/^\d+$/.test(errorCode)) {
      return NextResponse.json(
        { message: 'errorCode inválido. Use o código numérico ou "other".' },
        { status: 400 },
      );
    }

    const exists = await prisma.campaign.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return campaignNotFound();

    const result = await getCampaignRecipients({
      campaignId: id,
      status,
      errorCode,
      page: Number(searchParams.get("page")) || 1,
      perPage: Number(searchParams.get("perPage")) || 50,
    });

    return NextResponse.json({
      ...result,
      items: result.items.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contact: r.contact,
        status: r.status,
        errorCode: extractMetaErrorCode(r.errorMessage),
        errorMessage: r.errorMessage,
        sentAt: r.sentAt,
        deliveredAt: r.deliveredAt,
        readAt: r.readAt,
        repliedAt: r.repliedAt,
        createdAt: r.createdAt,
      })),
    });
  });
}
