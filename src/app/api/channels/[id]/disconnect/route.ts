import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { enqueueBaileysControl } from "@/lib/queue";
import { getChannelById, markChannelDisconnected } from "@/services/channels";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    const channel = await getChannelById(id);
    if (!channel) {
      return NextResponse.json({ message: "Canal não encontrado." }, { status: 404 });
    }

    // Bloco B (25/jun/26): POST disconnect exige `manage` do canal.
    const manageDenied = await requireChannelScope(session.user, "manage", id);
    if (manageDenied) return manageDenied;

    if (channel.provider === "BAILEYS_MD") {
      // logout (não disconnect): avisa o WhatsApp e some do aparelho.
      // disconnect só fecha o socket local — o celular continua vinculado.
      await enqueueBaileysControl({ channelId: id, action: "logout" });
    }

    const updated = await markChannelDisconnected(id);
    return NextResponse.json({
      channel: updated,
      message: "Canal desconectado.",
    });
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao desconectar canal.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
