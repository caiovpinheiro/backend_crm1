/**
 * Reagir a uma mensagem do grupo pelo CRM (como no WhatsApp).
 *   POST { emoji } — emoji vazio, ou o mesmo já usado, remove.
 * O número é um só: a reação é do número ("me"), quem reagir por último vale.
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { enqueueBaileysOutbound } from "@/lib/queue";
import {
  applyGroupMessageReaction,
  findConnectedBaileysChannel,
  findGroupMessageForAction,
  getWhatsAppGroup,
  parseGroupReactions,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; messageId: string }> };

export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:send");
    if (denied) return denied;

    let body: { emoji?: unknown };
    try {
      body = (await request.json()) as { emoji?: unknown };
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const wanted = typeof body.emoji === "string" ? body.emoji.trim() : "";
    // Um emoji (com variação/tom de pele cabe folgado em 16).
    if (wanted.length > 16) {
      return NextResponse.json({ message: "Reação inválida." }, { status: 400 });
    }

    const channel = await findConnectedBaileysChannel();
    if (!channel) {
      return NextResponse.json({ message: "Conecte um WhatsApp QR Code em Canais." }, { status: 409 });
    }
    const { id, messageId } = await context.params;
    const group = await getWhatsAppGroup(id, channel.id);
    if (!group) {
      return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
    }
    const target = await findGroupMessageForAction(group.id, messageId);
    if (!target) {
      return NextResponse.json({ message: "Mensagem não encontrada." }, { status: 404 });
    }
    if (!target.waMessageId) {
      return NextResponse.json(
        { message: "Esta mensagem é antiga e não pode receber reação pelo CRM." },
        { status: 409 },
      );
    }

    const mine = parseGroupReactions(target.reactions).find((r) => r.from === "me");
    const emoji = mine && mine.emoji === wanted ? "" : wanted;

    const job = await enqueueBaileysOutbound({
      channelId: channel.id,
      to: group.jid,
      content: "",
      messageType: "reaction",
      reaction: {
        emoji,
        key: {
          id: target.waMessageId,
          fromMe: target.fromMe,
          participant: target.fromMe ? null : target.fromJid,
        },
      },
    });
    if (!job) {
      return NextResponse.json({ message: "Fila indisponível. Tente de novo." }, { status: 503 });
    }
    const reactions = await applyGroupMessageReaction(target.id, target.reactions, {
      from: "me",
      emoji,
      name: session.user.name ?? null,
    });
    return NextResponse.json({ ok: true, reactions });
  });
}
