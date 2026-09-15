import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  findConnectedBaileysChannel,
  getWhatsAppGroup,
  openWhatsAppGroupMember,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; memberId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "whatsapp_group:view");
  if (denied) return denied;

  const channel = await findConnectedBaileysChannel();
  if (!channel) {
    return NextResponse.json(
      { message: "Conecte um WhatsApp QR Code em Canais." },
      { status: 409 },
    );
  }

  const { id, memberId } = await context.params;
  const group = await getWhatsAppGroup(id, channel.id);
  if (!group) {
    return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
  }

  const result = await openWhatsAppGroupMember({
    groupId: group.id,
    memberId,
    channelId: channel.id,
  });
  if ("error" in result) {
    return NextResponse.json({ message: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
