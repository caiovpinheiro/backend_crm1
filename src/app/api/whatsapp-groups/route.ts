import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  findConnectedBaileysChannel,
  listWhatsAppGroups,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "whatsapp_group:view");
  if (denied) return denied;

  const channel = await findConnectedBaileysChannel();
  if (!channel) {
    return NextResponse.json({ connected: false, channel: null, groups: [] });
  }

  const groups = await listWhatsAppGroups(channel.id);
  return NextResponse.json({
    connected: true,
    channel: { id: channel.id, name: channel.name, phoneNumber: channel.phoneNumber },
    groups,
  });
}

