import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/slash-shortcuts");

/**
 * Preferências pessoais do agente sobre os atalhos "/" (menu "Mensagens
 * prontas" do composer): favorito + contador de uso por item. Marcador
 * PESSOAL do agente logado (isolado por `userId`), escopado por org.
 *
 * `itemKind` casa com o discriminador do frontend:
 *   "internal-template" | "quick-reply" | "meta-template".
 * `itemId` é o id que o menu já usa para o item (para meta-template é o
 * `metaTemplateId`). Não há FK para o item de origem — os ids vêm de
 * tabelas distintas e o menu só renderiza o que existe hoje.
 */

const ALLOWED_KINDS = new Set(["internal-template", "quick-reply", "meta-template"]);

export type SlashShortcutDto = {
  itemKind: string;
  itemId: string;
  favorite: boolean;
  useCount: number;
};

/** GET /api/slash-shortcuts — lista as preferências do agente logado. */
export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const userId = (session.user as { id: string }).id;
      const rows = await prisma.agentMessageShortcut.findMany({
        where: { userId },
        select: { itemKind: true, itemId: true, favorite: true, useCount: true },
      });
      const items: SlashShortcutDto[] = rows.map((r) => ({
        itemKind: r.itemKind,
        itemId: r.itemId,
        favorite: r.favorite,
        useCount: r.useCount,
      }));
      return NextResponse.json({ items });
    } catch (e) {
      log.error({ err: e }, "[slash-shortcuts GET] falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}

/**
 * POST /api/slash-shortcuts
 *
 * Body `{ action, itemKind, itemId, favorite? }`:
 *   - action="favorite": marca/desmarca favorito. `favorite` explícito
 *     define o estado; omitido = toggle.
 *   - action="use": incrementa o contador de uso (chamado quando o agente
 *     insere/seleciona o item no menu "/").
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const userId = (session.user as { id: string }).id;
      const body = (await request.json().catch(() => ({}))) as {
        action?: unknown;
        itemKind?: unknown;
        itemId?: unknown;
        favorite?: unknown;
      };

      const action = body.action === "use" ? "use" : "favorite";
      const itemKind = typeof body.itemKind === "string" ? body.itemKind : "";
      const itemId = typeof body.itemId === "string" ? body.itemId : "";

      if (!ALLOWED_KINDS.has(itemKind) || !itemId) {
        return NextResponse.json(
          { message: "itemKind/itemId inválidos." },
          { status: 400 },
        );
      }

      const existing = await prisma.agentMessageShortcut.findFirst({
        where: { userId, itemKind, itemId },
      });

      if (action === "use") {
        if (existing) {
          const updated = await prisma.agentMessageShortcut.update({
            where: { id: existing.id },
            data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
            select: { favorite: true, useCount: true },
          });
          return NextResponse.json({
            itemKind,
            itemId,
            favorite: updated.favorite,
            useCount: updated.useCount,
          });
        }
        const created = await prisma.agentMessageShortcut.create({
          data: withOrgFromCtx({
            userId,
            itemKind,
            itemId,
            useCount: 1,
            lastUsedAt: new Date(),
          }),
          select: { favorite: true, useCount: true },
        });
        return NextResponse.json({
          itemKind,
          itemId,
          favorite: created.favorite,
          useCount: created.useCount,
        });
      }

      // action === "favorite"
      const nextFavorite =
        typeof body.favorite === "boolean" ? body.favorite : !existing?.favorite;

      if (existing) {
        const updated = await prisma.agentMessageShortcut.update({
          where: { id: existing.id },
          data: { favorite: nextFavorite },
          select: { favorite: true, useCount: true },
        });
        return NextResponse.json({
          itemKind,
          itemId,
          favorite: updated.favorite,
          useCount: updated.useCount,
        });
      }

      const created = await prisma.agentMessageShortcut.create({
        data: withOrgFromCtx({ userId, itemKind, itemId, favorite: nextFavorite }),
        select: { favorite: true, useCount: true },
      });
      return NextResponse.json({
        itemKind,
        itemId,
        favorite: created.favorite,
        useCount: created.useCount,
      });
    } catch (e) {
      log.error({ err: e }, "[slash-shortcuts POST] falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
