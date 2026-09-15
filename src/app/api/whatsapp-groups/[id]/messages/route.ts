import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { enqueueBaileysOutbound } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import {
  appendWhatsAppGroupMessage,
  findConnectedBaileysChannel,
  getWhatsAppGroup,
  listWhatsAppGroupMessages,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
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

  const { id } = await context.params;
  const group = await getWhatsAppGroup(id, channel.id);
  if (!group) {
    return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
  }

  const messages = await listWhatsAppGroupMessages(group.id);
  return NextResponse.json({ messages });
}

export async function POST(request: Request, context: RouteContext) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "whatsapp_group:send");
  if (denied) return denied;

  const channel = await findConnectedBaileysChannel();
  if (!channel) {
    return NextResponse.json(
      { message: "Conecte um WhatsApp QR Code em Canais." },
      { status: 409 },
    );
  }

  const { id } = await context.params;
  const group = await getWhatsAppGroup(id, channel.id);
  if (!group) {
    return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
  }

  let body: { text?: unknown };
  try {
    body = (await request.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ message: "Texto obrigatório." }, { status: 400 });
  }
  if (text.length > 4096) {
    return NextResponse.json({ message: "Texto longo demais." }, { status: 400 });
  }

  const job = await enqueueBaileysOutbound({
    channelId: channel.id,
    to: group.jid,
    content: text,
    messageType: "text",
  });
  if (!job) {
    return NextResponse.json({ message: "Fila indisponível. Tente de novo." }, { status: 503 });
  }
  // Não espera o worker aqui: o rewrite do frontend/Traefik corta ~10–15s
  // e devolve 502 HTML ("Servidor temporariamente indisponível").
  const message = await appendWhatsAppGroupMessage({
    organizationId: getOrgIdOrThrow(),
    groupId: group.id,
    fromJid: channel.phoneNumber ? `${channel.phoneNumber.replace(/\D/g, "")}@s.whatsapp.net` : "me",
    fromName: r.session.user.name ?? "Você",
    fromPhone: channel.phoneNumber,
    fromMe: true,
    text,
  });
  return NextResponse.json({ ok: true, groupId: group.id, message });
}
