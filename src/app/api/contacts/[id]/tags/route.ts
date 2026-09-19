import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import type { AppUserRole } from "@/lib/auth-types";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { logEvent } from "@/services/activity-log";
import { notifyTagAdded } from "@/services/automation-triggers";

type Ctx = { params: Promise<{ id: string }> };

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
// Fix 01/jun/26: trocado withOrgContext por withApiAuthContext para aceitar
// Bearer Token (ApiToken) além da sessão NextAuth, igual GET /api/contacts.
export async function POST(request: Request, ctx: Ctx) {
  return withApiAuthContext(request, async (user) => {
    try {
      const denied = await requirePermissionForUser(user, "contact:edit");
      if (denied) return denied;

      const { id: contactId } = await ctx.params;
      const body = (await request.json()) as Record<string, unknown>;
      const tagId = typeof body.tagId === "string" ? body.tagId.trim() : "";
      const tagName = typeof body.tagName === "string" ? body.tagName.trim() : "";
      const tagColor = typeof body.color === "string" ? body.color.trim() : "";

      if (!tagId && !tagName) {
        return NextResponse.json({ message: "tagId ou tagName obrigatório." }, { status: 400 });
      }

      let resolvedTagId = tagId;
      if (!resolvedTagId) {
        const orgId = getOrgIdOrThrow();
        const existing = await prisma.tag.findUnique({
          where: { organizationId_name: { organizationId: orgId, name: tagName } },
        });
        if (existing) {
          resolvedTagId = existing.id;
        } else {
          const role = user.role as AppUserRole;
          if (role !== "ADMIN" && role !== "MANAGER") {
            return NextResponse.json({ message: "Sem permissão para criar tags. Selecione uma existente." }, { status: 403 });
          }
          const tag = await prisma.tag.create({
            data: withOrgFromCtx({ name: tagName, color: tagColor || undefined }),
          });
          resolvedTagId = tag.id;
        }
      }

      const existed = await prisma.tagOnContact.findUnique({
        where: { contactId_tagId: { contactId, tagId: resolvedTagId } },
      });
      await prisma.tagOnContact.upsert({
        where: { contactId_tagId: { contactId, tagId: resolvedTagId } },
        update: {},
        create: { contactId, tagId: resolvedTagId },
      });
      if (!existed) {
        const tag = await prisma.tag.findUnique({
          where: { id: resolvedTagId },
          select: { name: true },
        });
        const contact = await prisma.contact.findUnique({
          where: { id: contactId },
          select: { name: true, phone: true, email: true },
        });
        void logEvent({
          type: "CONTACT_TAG_ADDED",
      actorType: "HUMAN",
          entityType: "CONTACT",
          entityId: contactId,
          entityLabel: contact?.name ?? contact?.phone ?? contact?.email ?? null,
          contactId,
          newValue: tag?.name ?? resolvedTagId,
          meta: { tagId: resolvedTagId, tagName: tag?.name ?? null },
        });
        void notifyTagAdded({
          contactId,
          tagId: resolvedTagId,
          tagName: tag?.name ?? tagName,
        });
      }

      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
    }
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return withApiAuthContext(request, async (user) => {
    try {
      const denied = await requirePermissionForUser(user, "contact:edit");
      if (denied) return denied;

      const { id: contactId } = await ctx.params;
      const body = (await request.json()) as Record<string, unknown>;
      const tagId = typeof body.tagId === "string" ? body.tagId : "";
      if (!tagId) return NextResponse.json({ message: "tagId obrigatório." }, { status: 400 });

      const tag = await prisma.tag.findUnique({
        where: { id: tagId },
        select: { name: true },
      });
      const removed = await prisma.tagOnContact.delete({
        where: { contactId_tagId: { contactId, tagId } },
      }).catch(() => null);
      if (removed) {
        const contact = await prisma.contact.findUnique({
          where: { id: contactId },
          select: { name: true, phone: true, email: true },
        });
        void logEvent({
          type: "CONTACT_TAG_REMOVED",
      actorType: "HUMAN",
          entityType: "CONTACT",
          entityId: contactId,
          entityLabel: contact?.name ?? contact?.phone ?? contact?.email ?? null,
          contactId,
          oldValue: tag?.name ?? tagId,
          meta: { tagId, tagName: tag?.name ?? null },
        });
      }

      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
    }
  });
}
