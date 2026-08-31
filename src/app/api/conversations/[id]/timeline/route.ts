import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/conversations/[id]/timeline
 *
 * Timeline de eventos DESTA conversa (org-scoped via Prisma extension +
 * `requireConversationAccess`). Diferente de `/api/activity-feed`, que e
 * um feed global restrito a MANAGER, este endpoint fica acessivel a
 * qualquer agente com acesso a conversa — igual `/messages`.
 *
 * Query params:
 *   - cursor  string (opcional, formato `${occurredAtMs}_${id}`)
 *   - after   alias de `cursor` (Kommo: created_at gt)
 *   - limit   int (default 50, max 200)
 *   - type    string ou csv (filtra tipos de evento)
 *
 * Resposta:
 *   { items: ActivityEvent[], nextCursor: string | null }
 *
 * Também inclui (quando existirem / como âncora sintética):
 *   - CONTACT_CREATED (data de criação do contato)
 *   - CREATED (data de criação do(s) negócio(s) do contato)
 */

type RouteContext = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseCursor(raw: string | null): { occurredAt: Date; id: string } | null {
  if (!raw) return null;
  const [tsStr, id] = raw.split("_");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !id) return null;
  return { occurredAt: new Date(ts), id };
}

function parseCsv(raw: string | null): string[] | null {
  if (!raw) return null;
  const arr = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : null;
}

type TimelineItem = {
  id: string;
  type: string;
  occurredAt: Date;
  meta: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
  entityLabel?: string | null;
  dealId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  actorType?: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  actorUser?: { id: string; name: string | null; avatarUrl: string | null } | null;
  synthetic?: boolean;
};

function cmpDesc(a: TimelineItem, b: TimelineItem): number {
  const dt = b.occurredAt.getTime() - a.occurredAt.getTime();
  if (dt !== 0) return dt;
  return b.id.localeCompare(a.id);
}

function passesCursor(item: TimelineItem, cursor: { occurredAt: Date; id: string }): boolean {
  const t = item.occurredAt.getTime();
  const ct = cursor.occurredAt.getTime();
  if (t < ct) return true;
  if (t > ct) return false;
  return item.id < cursor.id;
}

export async function GET(req: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id: conversationId } = await context.params;

      const denied = await requireConversationAccess(session, conversationId);
      if (denied) return denied;

      const url = new URL(req.url);
      const sp = url.searchParams;

      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Number(sp.get("limit") ?? DEFAULT_LIMIT) | 0 || DEFAULT_LIMIT),
      );
      const cursor = parseCursor(sp.get("cursor") ?? sp.get("after"));
      const types = parseCsv(sp.get("type"));

      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          contactId: true,
          contact: {
            select: { id: true, name: true, phone: true, createdAt: true },
          },
        },
      });

      const contact = conv?.contact ?? null;
      const contactId = contact?.id ?? conv?.contactId ?? null;

      const deals = contactId
        ? await prisma.deal.findMany({
            where: { contactId },
            select: {
              id: true,
              title: true,
              number: true,
              createdAt: true,
            },
            orderBy: { createdAt: "asc" },
            take: 50,
          })
        : [];
      const dealIds = deals.map((d) => d.id);

      const DEAL_SCOPED_TYPES = ["STAGE_CHANGED", "STATUS_CHANGED", "CREATED"];
      const CONTACT_SCOPED_TYPES = ["CONTACT_CREATED"];

      const scopeOr: Prisma.ActivityEventWhereInput[] = [{ conversationId }];
      if (dealIds.length > 0) {
        scopeOr.push({ dealId: { in: dealIds }, type: { in: DEAL_SCOPED_TYPES } });
      }
      if (contactId) {
        scopeOr.push({ contactId, type: { in: CONTACT_SCOPED_TYPES } });
      }

      const where: Prisma.ActivityEventWhereInput = { OR: scopeOr };
      if (types) where.type = { in: types };

      if (cursor) {
        const cursorAnd: Prisma.ActivityEventWhereInput = {
          OR: [
            { occurredAt: { lt: cursor.occurredAt } },
            { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
          ],
        };
        where.AND = where.AND
          ? Array.isArray(where.AND)
            ? [...where.AND, cursorAnd]
            : [where.AND, cursorAnd]
          : cursorAnd;
      }

      const rows = await prisma.activityEvent.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        include: {
          actorUser: { select: { id: true, name: true, avatarUrl: true } },
        },
      });

      const items: TimelineItem[] = rows.map((a) => ({
        id: a.id,
        type: a.type,
        occurredAt: a.occurredAt,
        meta: (a.meta ?? {}) as Record<string, unknown>,
        entityType: a.entityType,
        entityId: a.entityId,
        entityLabel: a.entityLabel,
        dealId: a.dealId,
        contactId: a.contactId,
        conversationId: a.conversationId,
        actorType: a.actorType,
        actorUserId: a.actorUserId,
        actorLabel: a.actorLabel,
        actorUser: a.actorUser,
      }));

      // Âncoras de criação: se não há evento real, sintetiza a partir de
      // Contact.createdAt / Deal.createdAt para a timeline e os logs
      // sempre mostrarem a data de criação.
      const synthetics: TimelineItem[] = [];

      const [contactCreatedRow, dealCreatedRows] = await Promise.all([
        contactId
          ? prisma.activityEvent.findFirst({
              where: { contactId, type: "CONTACT_CREATED" },
              select: { id: true },
            })
          : Promise.resolve(null),
        dealIds.length > 0
          ? prisma.activityEvent.findMany({
              where: { dealId: { in: dealIds }, type: "CREATED" },
              select: { dealId: true },
              distinct: ["dealId"],
            })
          : Promise.resolve([] as { dealId: string | null }[]),
      ]);
      const dealsWithCreated = new Set(
        dealCreatedRows.map((r) => r.dealId).filter((id): id is string => !!id),
      );

      if (contact && !contactCreatedRow) {
        synthetics.push({
          id: `synthetic:contact-created:${contact.id}`,
          type: "CONTACT_CREATED",
          occurredAt: contact.createdAt,
          meta: {
            synthetic: true,
            createdAt: contact.createdAt.toISOString(),
          },
          entityType: "CONTACT",
          entityId: contact.id,
          entityLabel: contact.name ?? contact.phone ?? null,
          contactId: contact.id,
          actorType: "SYSTEM",
          actorLabel: "Sistema",
          synthetic: true,
        });
      }

      for (const deal of deals) {
        if (dealsWithCreated.has(deal.id)) continue;
        synthetics.push({
          id: `synthetic:deal-created:${deal.id}`,
          type: "CREATED",
          occurredAt: deal.createdAt,
          meta: {
            synthetic: true,
            createdAt: deal.createdAt.toISOString(),
            dealNumber: deal.number,
          },
          entityType: "DEAL",
          entityId: deal.id,
          entityLabel: deal.title ?? (deal.number != null ? `Negócio #${deal.number}` : null),
          dealId: deal.id,
          contactId: contactId,
          actorType: "SYSTEM",
          actorLabel: "Sistema",
          synthetic: true,
        });
      }

      const typeFilter = types ? new Set(types) : null;
      const extra = synthetics.filter((s) => {
        if (typeFilter && !typeFilter.has(s.type)) return false;
        if (cursor && !passesCursor(s, cursor)) return false;
        return true;
      });

      const merged = [...items, ...extra].sort(cmpDesc);
      const page = merged.slice(0, limit);
      const hasMore = merged.length > limit;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? `${last.occurredAt.getTime()}_${last.id}` : null;

      return NextResponse.json({
        items: page.map((i) => ({
          ...i,
          occurredAt: i.occurredAt.toISOString(),
        })),
        nextCursor,
      });
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
