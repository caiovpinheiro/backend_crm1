import { NextResponse } from "next/server";

import type { Prisma } from "@prisma/client";

import { requireManager } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/activity-feed
 *
 * Feed global de atividade (org-scoped, cronologico descendente) com
 * paginacao por cursor composto (occurredAt + id — desempate estavel
 * em eventos do mesmo instante).
 *
 * Query params:
 *   - cursor          string (opcional, formato `${occurredAtMs}_${id}`)
 *   - limit           int (default 50, max 200)
 *   - entityType      EventEntityType (csv aceito: "DEAL,CONTACT")
 *   - actorType       ActorType (csv aceito)
 *   - actorUserId     userId
 *   - type            string ou csv (filtra tipos de evento)
 *   - dateFrom        ISO date
 *   - dateTo          ISO date
 *   - entityId        id (para timeline de uma entidade especifica)
 *   - dealId          id (atalho — filtra dealId direto)
 *   - contactId       id
 *   - conversationId  id
 *   - q               busca textual (entityLabel ILIKE / actorLabel ILIKE)
 *   - tabulated       "1" — só CONVERSATION_TABULATED
 *   - tabulationId    csv de meta.tabulationId (força tabulated)
 *
 * Resposta:
 *   { items: ActivityFeedRow[], nextCursor: string | null }
 */

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

export async function GET(req: Request) {
  try {
    // Logs são restritos a gestão (ADMIN/MANAGER). requireManager também
    // configura o RequestContext, então o prisma scoped abaixo funciona.
    const r = await requireManager();
    if (!r.ok) return r.response;

    const url = new URL(req.url);
    const sp = url.searchParams;

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(sp.get("limit") ?? DEFAULT_LIMIT) | 0 || DEFAULT_LIMIT),
    );
    const cursor = parseCursor(sp.get("cursor"));

    const entityTypes = parseCsv(sp.get("entityType"));
    const actorTypes = parseCsv(sp.get("actorType"));
    const types = parseCsv(sp.get("type"));
    const actorUserId = sp.get("actorUserId");
    const entityId = sp.get("entityId");
    const dealId = sp.get("dealId");
    const contactId = sp.get("contactId");
    const conversationId = sp.get("conversationId");
    const dateFrom = sp.get("dateFrom");
    const dateTo = sp.get("dateTo");
    const q = sp.get("q")?.trim();

    // Transição de fase — quando qualquer eixo (pipeline / from / to) é
    // informado, força type = STAGE_CHANGED e filtra pelos ids no meta JSON.
    const stagePipelineId = sp.get("stagePipelineId");
    const stageFrom = parseCsv(sp.get("stageFrom"));
    const stageTo = parseCsv(sp.get("stageTo"));
    const hasStageTransition = Boolean(
      stagePipelineId || stageFrom || stageTo,
    );
    const tabulationIds = parseCsv(sp.get("tabulationId"));
    const tabulatedOnly =
      sp.get("tabulated") === "1" || Boolean(tabulationIds);

    const where: Prisma.ActivityEventWhereInput = {};

    if (entityTypes) {
      // Cast: enums Prisma sao string em runtime; o cliente nao expoe
      // o tipo literal `EventEntityType` aqui de forma generica sem
      // ts2322. Validacao real fica na constraint do enum no banco.
      (where as Record<string, unknown>).entityType = { in: entityTypes };
    }
    if (actorTypes) {
      (where as Record<string, unknown>).actorType = { in: actorTypes };
    }
    if (types) where.type = { in: types };

    // Se transição de fase foi solicitada, sobrescreve o filtro de tipo
    // (STAGE_CHANGED é o único que carrega fromStageId/toStageId no meta).
    if (hasStageTransition) {
      where.type = "STAGE_CHANGED";
    } else if (tabulatedOnly) {
      where.type = "CONVERSATION_TABULATED";
    }
    if (actorUserId) where.actorUserId = actorUserId;
    if (entityId) where.entityId = entityId;
    if (dealId) where.dealId = dealId;
    if (contactId) where.contactId = contactId;
    if (conversationId) where.conversationId = conversationId;

    if (dateFrom || dateTo) {
      where.occurredAt = {};
      if (dateFrom) (where.occurredAt as { gte?: Date }).gte = new Date(dateFrom);
      if (dateTo) (where.occurredAt as { lte?: Date }).lte = new Date(dateTo);
    }

    if (q) {
      where.OR = [
        { entityLabel: { contains: q, mode: "insensitive" } },
        { actorLabel: { contains: q, mode: "insensitive" } },
        { actorSublabel: { contains: q, mode: "insensitive" } },
        { type: { contains: q, mode: "insensitive" } },
      ];
    }

    // Filtros de transição de fase — JSON path filter no meta.
    // Estrutura gravada em STAGE_CHANGED (deals routes):
    //   meta.fromStageId, meta.toStageId, meta.to.pipelineId, meta.pipelineId
    if (hasStageTransition) {
      const stageAnd: Prisma.ActivityEventWhereInput[] = [];
      if (stageFrom) {
        stageAnd.push({
          OR: stageFrom.map((id) => ({
            meta: { path: ["fromStageId"], equals: id },
          })),
        });
      }
      if (stageTo) {
        stageAnd.push({
          OR: stageTo.map((id) => ({
            meta: { path: ["toStageId"], equals: id },
          })),
        });
      }
      if (stagePipelineId) {
        stageAnd.push({
          OR: [
            { meta: { path: ["pipelineId"], equals: stagePipelineId } },
            { meta: { path: ["to", "pipelineId"], equals: stagePipelineId } },
          ],
        });
      }
      where.AND = where.AND
        ? Array.isArray(where.AND)
          ? [...where.AND, ...stageAnd]
          : [where.AND, ...stageAnd]
        : stageAnd;
    }

    if (tabulationIds && !hasStageTransition) {
      const tabAnd: Prisma.ActivityEventWhereInput = {
        OR: tabulationIds.map((id) => ({
          meta: { path: ["tabulationId"], equals: id },
        })),
      };
      where.AND = where.AND
        ? Array.isArray(where.AND)
          ? [...where.AND, tabAnd]
          : [where.AND, tabAnd]
        : [tabAnd];
    }

    // Cursor composto: occurredAt desc, id desc (desempate estavel).
    // Em SQL puro seria:
    //   WHERE (occurredAt, id) < (:cursorAt, :cursorId)
    // Como Prisma nao suporta tupla, usamos OR canonico:
    if (cursor) {
      const cursorAnd: Prisma.ActivityEventWhereInput = {
        OR: [
          { occurredAt: { lt: cursor.occurredAt } },
          {
            occurredAt: cursor.occurredAt,
            id: { lt: cursor.id },
          },
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

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? `${last.occurredAt.getTime()}_${last.id}` : null;

    // Enriquecimento aditivo: anexa o nome do contato em eventos que
    // possuam contactId. Útil em MESSAGE_SENT/RECEIVED para exibir
    // "Cliente: <nome>" no feed, já que o entityLabel nesses casos
    // representa apenas um dos lados da conversa.
    const contactIds = Array.from(
      new Set(
        items
          .map((r) => r.contactId)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    );

    const contactMap = new Map<string, string | null>();
    if (contactIds.length > 0) {
      const contacts = await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, name: true },
      });
      for (const c of contacts) contactMap.set(c.id, c.name ?? null);
    }

    const enriched = items.map((row) => ({
      ...row,
      contactName: row.contactId ? contactMap.get(row.contactId) ?? null : null,
    }));

    return NextResponse.json({ items: enriched, nextCursor });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}
