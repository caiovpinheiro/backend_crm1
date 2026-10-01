import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getChannelById } from "@/services/channels";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/[id]/status");

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
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

    return NextResponse.json({
      status: channel.status,
      phoneNumber: channel.phoneNumber ?? undefined,
    });
  } catch (e: unknown) {
    log.error({ err: e }, "GET falhou");
    const msg = e instanceof Error ? e.message : "Erro ao consultar status.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
