/**
 * "Mídia, links e docs" do grupo.
 *   GET ?kind=summary            → totais + 3 fotos/vídeos mais recentes (painel do grupo)
 *   GET ?kind=media|docs|links   → lista da aba (`before` = ISO para a próxima página)
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  countGroupMedia,
  listGroupLinks,
  listGroupMediaItems,
} from "@/services/whatsapp-group-media";
import { findConnectedBaileysChannel, getWhatsAppGroup } from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const KINDS = new Set(["summary", "media", "docs", "links"]);

export async function GET(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:view");
    if (denied) return denied;

    const channel = await findConnectedBaileysChannel();
    if (!channel) {
      return NextResponse.json({ message: "Conecte um WhatsApp QR Code em Canais." }, { status: 409 });
    }
    const { id } = await context.params;
    const group = await getWhatsAppGroup(id, channel.id);
    if (!group) {
      return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
    }

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "summary";
    if (!KINDS.has(kind)) {
      return NextResponse.json({ message: "Tipo inválido." }, { status: 400 });
    }
    const rawBefore = url.searchParams.get("before");
    const before = rawBefore ? new Date(rawBefore) : null;
    if (before && Number.isNaN(before.getTime())) {
      return NextResponse.json({ message: "Data inválida." }, { status: 400 });
    }

    if (kind === "summary") {
      const [counts, recent] = await Promise.all([
        countGroupMedia(group.id),
        listGroupMediaItems(group.id, "media", { limit: 3 }),
      ]);
      return NextResponse.json({ counts, recent });
    }
    if (kind === "links") {
      return NextResponse.json({ links: await listGroupLinks(group.id, { before }) });
    }
    return NextResponse.json({
      items: await listGroupMediaItems(group.id, kind as "media" | "docs", { before }),
    });
  });
}
