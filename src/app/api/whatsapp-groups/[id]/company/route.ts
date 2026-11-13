/**
 * Empresa vinculada ao grupo WhatsApp.
 *   PUT { companyId: string | null } — vincula, troca ou desvincula.
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { findConnectedBaileysChannel, setWhatsAppGroupCompany } from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:send");
    if (denied) return denied;

    let body: { companyId?: unknown };
    try {
      body = (await request.json()) as { companyId?: unknown };
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const companyId = body.companyId;
    if (companyId !== null && (typeof companyId !== "string" || !companyId.trim())) {
      return NextResponse.json({ message: "Informe a empresa ou null para desvincular." }, { status: 400 });
    }

    const channel = await findConnectedBaileysChannel();
    if (!channel) {
      return NextResponse.json({ message: "Conecte um WhatsApp QR Code em Canais." }, { status: 409 });
    }
    const { id } = await context.params;
    const result = await setWhatsAppGroupCompany({
      groupId: id,
      channelId: channel.id,
      companyId: companyId === null ? null : (companyId as string).trim(),
    });
    if ("error" in result) {
      return NextResponse.json({ message: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  });
}
