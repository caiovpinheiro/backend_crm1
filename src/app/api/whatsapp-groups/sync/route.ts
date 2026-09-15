import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { enqueueBaileysControl } from "@/lib/queue";
import { findConnectedBaileysChannel } from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

export async function POST() {
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

  const job = await enqueueBaileysControl({ channelId: channel.id, action: "sync-groups" });
  if (!job) {
    return NextResponse.json({ message: "Fila indisponível. Tente de novo." }, { status: 503 });
  }
  return NextResponse.json({ ok: true, channelId: channel.id });
}
