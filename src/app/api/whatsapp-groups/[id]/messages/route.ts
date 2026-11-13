import { NextResponse } from "next/server";

import { requireAuth, withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getLogger } from "@/lib/logger";
import { enqueueBaileysOutbound } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import {
  appendWhatsAppGroupMessage,
  deleteGroupMessage,
  groupReplyFor,
  findConnectedBaileysChannel,
  getWhatsAppGroup,
  listWhatsAppGroupMessages,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

const log = getLogger("whatsapp-groups");

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

  try {
    const messages = await listWhatsAppGroupMessages(group.id);
    return NextResponse.json({ messages });
  } catch (err) {
    // Sem isto o Next devolvia 500 sem corpo JSON e a tela ficava vazia, sem aviso.
    log.error({ groupId: group.id, err: errMessage(err) }, "[whatsapp-groups] falha ao listar mensagens");
    return NextResponse.json(
      { message: "Não foi possível carregar as mensagens do grupo." },
      { status: 500 },
    );
  }
}

// `runWithContext` (withOrgContext) e não só o `enterWith` do requireAuth:
// depois de ler o corpo (`formData`/`json`) o contexto da org se perdia e
// `getOrgIdOrThrow` estourava — 500 sem corpo ("Servidor temporariamente
// indisponível") e mensagem enviada sem entrar no histórico do grupo.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:send");
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

    let body: { text?: unknown; replyToMessageId?: unknown };
    try {
      body = (await request.json()) as { text?: unknown; replyToMessageId?: unknown };
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

    // Responder: cita a mensagem original (como no WhatsApp).
    let reply: Extract<Awaited<ReturnType<typeof groupReplyFor>>, { quoted: unknown }> | null = null;
    if (typeof body.replyToMessageId === "string" && body.replyToMessageId) {
      const r = await groupReplyFor(group.id, body.replyToMessageId);
      if ("error" in r) return NextResponse.json({ message: r.error }, { status: r.status });
      reply = r;
    }

    // Grava antes de enfileirar: o worker precisa do id para guardar o id
    // do WhatsApp (reagir/responder depois). Falha ao gravar o histórico não
    // impede o envio nem vira 500 sem corpo.
    let message: Awaited<ReturnType<typeof appendWhatsAppGroupMessage>> = null;
    try {
      message = await appendWhatsAppGroupMessage({
        organizationId: getOrgIdOrThrow(),
        groupId: group.id,
        fromJid: channel.phoneNumber ? `${channel.phoneNumber.replace(/\D/g, "")}@s.whatsapp.net` : "me",
        fromName: session.user.name ?? "Você",
        fromPhone: channel.phoneNumber,
        fromMe: true,
        text,
        replyTo: reply?.replyTo ?? null,
      });
    } catch (err) {
      log.error({ groupId: group.id, err: errMessage(err) }, "[whatsapp-groups] mensagem não gravada no histórico");
    }

    // Não espera o worker aqui: o rewrite do frontend/Traefik corta ~10–15s
    // e devolve 502 HTML ("Servidor temporariamente indisponível").
    const job = await enqueueBaileysOutbound({
      channelId: channel.id,
      to: group.jid,
      content: text,
      messageType: "text",
      ...(message ? { groupMessageId: message.id } : {}),
      ...(reply ? { quoted: reply.quoted } : {}),
    });
    if (!job) {
      if (message) await deleteGroupMessage(message.id).catch(() => {});
      return NextResponse.json({ message: "Fila indisponível. Tente de novo." }, { status: 503 });
    }
    return NextResponse.json({ ok: true, groupId: group.id, message });
  });
}
