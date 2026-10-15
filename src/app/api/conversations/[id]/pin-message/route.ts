import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { noteMessageChange } from "@/lib/cache/message-versions";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

type Ctx = { params: Promise<{ id: string }> };

/** Prazos aceitos pelo picker (estilo WhatsApp: 24h / 7 dias / 30 dias). */
const DURATION_HOURS = new Set([24, 24 * 7, 24 * 30]);

/** Teto de fixadas simultâneas por conversa — igual ao WhatsApp. */
const MAX_PINS = 3;

/**
 * Resolve o `messageId` recebido do frontend (que pode ser o `externalId`
 * / wamid usado como chave de bolha, ou o `id` interno cuid) para o `id`
 * INTERNO persistido em `PinnedMessage.messageId`.
 */
async function resolveInternalId(conversationId: string, ref: string): Promise<string | null> {
  const msg = await prisma.message.findFirst({
    where: { conversationId, OR: [{ id: ref }, { externalId: ref }] },
    select: { id: true },
  });
  return msg?.id ?? null;
}

/**
 * PUT /api/conversations/:id/pin-message
 *
 * FIXA uma mensagem no topo da conversa (banner estilo WhatsApp). Ao
 * contrário do slot único antigo, agora várias mensagens podem ficar
 * fixadas ao mesmo tempo (teto de {@link MAX_PINS}). Fixar a mesma
 * mensagem duas vezes é idempotente (renova só o prazo).
 *
 * Body: `{ messageId: string, durationHours?: number }`.
 * `durationHours` ausente = sem prazo; valores aceitos: 24, 168, 720.
 */
export async function PUT(req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;
    const denied = await requireConversationAccess(session, id);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const ref: string | null =
      typeof body?.messageId === "string" ? body.messageId : null;
    if (!ref) {
      return NextResponse.json(
        { message: "messageId obrigatório." },
        { status: 400 },
      );
    }
    const durationHours: number | null =
      typeof body?.durationHours === "number" && DURATION_HOURS.has(body.durationHours)
        ? body.durationHours
        : null;

    const internalId = await resolveInternalId(id, ref);
    if (!internalId) {
      return NextResponse.json(
        { message: "Mensagem não encontrada nesta conversa." },
        { status: 404 },
      );
    }

    const expiresAt = durationHours
      ? new Date(Date.now() + durationHours * 60 * 60 * 1000)
      : null;

    // Já fixada? Só renova o prazo (idempotente) — não conta contra o teto.
    const existing = await prisma.pinnedMessage.findUnique({
      where: { conversationId_messageId: { conversationId: id, messageId: internalId } },
      select: { id: true },
    });
    if (existing) {
      await prisma.pinnedMessage.update({ where: { id: existing.id }, data: { expiresAt } });
    } else {
      const count = await prisma.pinnedMessage.count({ where: { conversationId: id } });
      if (count >= MAX_PINS) {
        return NextResponse.json(
          { message: `Limite de ${MAX_PINS} mensagens fixadas atingido. Desafixe uma antes.` },
          { status: 409 },
        );
      }
      await prisma.pinnedMessage.create({
        data: withOrgFromCtx({ conversationId: id, messageId: internalId, expiresAt }),
      });
    }
    void noteMessageChange(getOrgIdOrNull(), id, "meta");

    return NextResponse.json({ ok: true });
  });
}

/**
 * DELETE /api/conversations/:id/pin-message
 *
 * DESAFIXA uma mensagem específica. Body: `{ messageId: string }`.
 * (Sem `messageId` seria ambíguo com múltiplas fixadas — obrigatório.)
 */
export async function DELETE(req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;
    const denied = await requireConversationAccess(session, id);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const ref: string | null =
      typeof body?.messageId === "string" ? body.messageId : null;
    if (!ref) {
      return NextResponse.json({ message: "messageId obrigatório." }, { status: 400 });
    }

    const internalId = await resolveInternalId(id, ref);
    if (internalId) {
      await prisma.pinnedMessage.deleteMany({
        where: { conversationId: id, messageId: internalId },
      });
      void noteMessageChange(getOrgIdOrNull(), id, "meta");
    }

    return NextResponse.json({ ok: true });
  });
}
