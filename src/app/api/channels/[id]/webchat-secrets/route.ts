import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import { webchatSecretsStatus } from "@/lib/webchat/secrets";
import { prisma } from "@/lib/prisma";

const log = getLogger("api/channels/[id]/webchat-secrets");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/channels/:id/webchat-secrets — status dos segredos v2 do canal
 * WEBCHAT: `{ secrets: { identity, s2s } }`, cada um `{ configured, rotatedAt }`.
 * Nunca devolve o valor (docs/decisoes/webchat-widget.md §9.5). Exige
 * `manage` no canal.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await context.params;
    const denied = await requireChannelScope(session.user, "manage", id);
    if (denied) return denied;
    const channel = await prisma.channel.findUnique({
      where: { id },
      select: { provider: true, config: true },
    });
    if (!channel || channel.provider !== "WEBCHAT") {
      return NextResponse.json({ message: "Canal Webchat não encontrado." }, { status: 404 });
    }
    return NextResponse.json(
      { secrets: webchatSecretsStatus(channel.config) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e: unknown) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json({ message: "Erro ao ler os segredos do canal." }, { status: 500 });
  }
}
