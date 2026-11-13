/**
 * Alguém abriu o grupo no CRM: o contador de não lidas zera para todos que
 * usam o mesmo número QR (o "visto" é do grupo, não da pessoa).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  findConnectedBaileysChannel,
  markWhatsAppGroupRead,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:view");
    if (denied) return denied;

    const channel = await findConnectedBaileysChannel();
    if (!channel) {
      return NextResponse.json({ message: "Conecte um WhatsApp QR Code em Canais." }, { status: 409 });
    }
    const { id } = await context.params;
    await markWhatsAppGroupRead(id, channel.id);
    return NextResponse.json({ ok: true });
  });
}
