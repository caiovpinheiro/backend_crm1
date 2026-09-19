/**
 * POST / DELETE /api/conversations/:id/tags
 *
 * Endpoint usado pelo `TagPopover` da Inbox. No modelo atual não existe
 * `TagOnConversation`: uma conversa herda tags do `Contact` e, quando há,
 * do `Deal` OPEN vinculado. Este route aplica/remove a tag nas DUAS pontas:
 *
 *   - `TagOnContact`  — garante que a etiqueta segue o lead mesmo após a
 *                        conversa ser encerrada.
 *   - `TagOnDeal`     — quando há um deal OPEN do contato, replica a mesma
 *                        etiqueta no negócio para aparecer no Kanban/Pipeline
 *                        e gerar timeline event (`TAG_ADDED` / `TAG_REMOVED`).
 *
 * Contrato:
 *   POST   { tagId: string, action: "add" | "remove" }  // action opcional (default "add")
 *   DELETE { tagId: string }
 *
 * Resposta:
 *   { ok: true, appliedToContact: boolean, appliedToDeal: string | null }
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { notifyTagAdded } from "@/services/automation-triggers";
import { logEvent } from "@/services/activity-log";
import { createDealEvent } from "@/services/deals";

type Ctx = { params: Promise<{ id: string }> };

async function loadConversationTargets(conversationId: string) {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      contactId: true,
      contact: {
        select: {
          id: true,
          deals: {
            where: { status: "OPEN" },
            select: { id: true },
            orderBy: { updatedAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });
  if (!row) return null;
  const contactId = row.contactId ?? row.contact?.id ?? null;
  const dealId = row.contact?.deals[0]?.id ?? null;
  return { contactId, dealId };
}

async function applyTagToTargets(
  userId: string,
  tagId: string,
  targets: { contactId: string | null; dealId: string | null },
  action: "add" | "remove",
) {
  let appliedToContact = false;
  let appliedToDeal: string | null = null;
  let isNewOnContact = false;
  let isNewOnDeal = false;

  if (targets.contactId) {
    if (action === "add") {
      const existedOnContact = await prisma.tagOnContact.findUnique({
        where: { contactId_tagId: { contactId: targets.contactId, tagId } },
      });
      isNewOnContact = !existedOnContact;
      await prisma.tagOnContact.upsert({
        where: { contactId_tagId: { contactId: targets.contactId, tagId } },
        update: {},
        create: { contactId: targets.contactId, tagId },
      });
    } else {
      await prisma.tagOnContact
        .delete({ where: { contactId_tagId: { contactId: targets.contactId, tagId } } })
        .catch(() => {});
    }
    appliedToContact = true;
  }

  if (targets.dealId) {
    if (action === "add") {
      const existedOnDeal = await prisma.tagOnDeal.findUnique({
        where: { dealId_tagId: { dealId: targets.dealId, tagId } },
      });
      isNewOnDeal = !existedOnDeal;
      await prisma.tagOnDeal.upsert({
        where: { dealId_tagId: { dealId: targets.dealId, tagId } },
        update: {},
        create: { dealId: targets.dealId, tagId },
      });
    } else {
      await prisma.tagOnDeal
        .delete({ where: { dealId_tagId: { dealId: targets.dealId, tagId } } })
        .catch(() => {});
    }
    appliedToDeal = targets.dealId;

    const tag = await prisma.tag.findUnique({
      where: { id: tagId },
      select: { name: true, color: true },
    });
    const eventType = action === "add" ? "TAG_ADDED" : "TAG_REMOVED";
    createDealEvent(targets.dealId, userId, eventType, {
      tagName: tag?.name ?? tagId,
      tagColor: tag?.color ?? "",
    }).catch(() => {});
  }

  // Dispara a automação `tag_added` uma única vez, só quando a tag foi
  // efetivamente nova em pelo menos um dos alvos (não re-aplicada).
  if (action === "add" && (isNewOnContact || isNewOnDeal)) {
    const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { name: true } });
    void notifyTagAdded({
      contactId: targets.contactId,
      dealId: targets.dealId,
      tagId,
      tagName: tag?.name ?? tagId,
    });
  }

  return { appliedToContact, appliedToDeal };
}

// Bug 29/mai/26: usávamos `auth()` direto, mas as queries via `prisma`
// org-scoped (loadConversationTargets / applyTagToTargets) avaliam
// `getOrgIdOrThrow()` na Prisma extension — que exige o contexto criado
// por `withOrgContext`. Sem o wrapper, o handler quebrava com
// "organization context ausente". Mesmo fix já aplicado em deals/contacts.
export async function POST(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await ctx.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return NextResponse.json({ message: "JSON inválido." }, { status: 400 });

      const tagId = typeof body.tagId === "string" ? body.tagId.trim() : "";
      const action = body.action === "remove" ? "remove" : "add";
      if (!tagId) return NextResponse.json({ message: "tagId obrigatório." }, { status: 400 });

      const targets = await loadConversationTargets(id);
      if (!targets) return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });

      const tagExists = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } });
      if (!tagExists) return NextResponse.json({ message: "Tag não encontrada." }, { status: 404 });

      const uid = (session.user as { id: string }).id;
      const result = await applyTagToTargets(uid, tagId, targets, action);
      const tag = await prisma.tag.findUnique({
        where: { id: tagId },
        select: { name: true },
      });
      void logEvent({
        type: action === "remove" ? "TAG_REMOVED" : "TAG_ADDED",
        entityType: "CONVERSATION",
        entityId: id,
        conversationId: id,
        contactId: targets.contactId,
        dealId: targets.dealId,
        actorType: "HUMAN",
        newValue: tag?.name ?? tagId,
        meta: { tagName: tag?.name ?? tagId, tagId },
      });

      return NextResponse.json({ ok: true, action, ...result });
    } catch (e) {
      console.error("[conversations/tags] erro:", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao aplicar tag." },
        { status: 500 },
      );
    }
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await ctx.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const tagId = typeof body?.tagId === "string" ? body.tagId.trim() : "";
      if (!tagId) return NextResponse.json({ message: "tagId obrigatório." }, { status: 400 });

      const targets = await loadConversationTargets(id);
      if (!targets) return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });

      const uid = (session.user as { id: string }).id;
      const result = await applyTagToTargets(uid, tagId, targets, "remove");
      const tag = await prisma.tag.findUnique({
        where: { id: tagId },
        select: { name: true },
      });
      void logEvent({
        type: "TAG_REMOVED",
      actorType: "HUMAN",
        entityType: "CONVERSATION",
        entityId: id,
        conversationId: id,
        contactId: targets.contactId,
        dealId: targets.dealId,
        newValue: tag?.name ?? tagId,
        meta: { tagName: tag?.name ?? tagId, tagId },
      });

      return NextResponse.json({ ok: true, action: "remove", ...result });
    } catch (e) {
      console.error("[conversations/tags] erro:", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao remover tag." },
        { status: 500 },
      );
    }
  });
}
