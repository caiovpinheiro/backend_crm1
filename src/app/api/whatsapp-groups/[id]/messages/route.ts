import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { enqueueBaileysOutbound, waitForBaileysOutboundJob } from "@/lib/queue";
import {
  findConnectedBaileysChannel,
  getWhatsAppGroup,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

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
  try {
    await waitForBaileysOutboundJob(job);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const disconnected = /não conectada|ainda conectando/i.test(raw);
    const timeout = /timed out|timeout/i.test(raw);
    return NextResponse.json(
      {
        message: disconnected
          ? "WhatsApp QR desconectou. Escaneie de novo em Canais."
          : timeout
            ? "WhatsApp não confirmou o envio. Tente de novo."
            : raw || "Falha ao enviar no grupo.",
      },
      { status: disconnected ? 409 : timeout ? 504 : 502 },
    );
  }
  return NextResponse.json({ ok: true, groupId: group.id });
}
