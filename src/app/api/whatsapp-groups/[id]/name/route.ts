/**
 * Apelido interno do grupo WhatsApp (só no CRM; o nome no WhatsApp não muda).
 *   PUT { customName: string | null } — define, troca ou apaga (vazio/null).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { findConnectedBaileysChannel, setWhatsAppGroupCustomName } from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:send");
    if (denied) return denied;

    let body: { customName?: unknown };
    try {
      body = (await request.json()) as { customName?: unknown };
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const customName = body.customName;
    if (customName !== null && typeof customName !== "string") {
      return NextResponse.json({ message: "Informe o apelido ou null para apagar." }, { status: 400 });
    }

    const channel = await findConnectedBaileysChannel();
    if (!channel) {
      return NextResponse.json({ message: "Conecte um WhatsApp QR Code em Canais." }, { status: 409 });
    }
    const { id } = await context.params;
    const result = await setWhatsAppGroupCustomName({ groupId: id, channelId: channel.id, customName });
    if ("error" in result) {
      return NextResponse.json({ message: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  });
}
