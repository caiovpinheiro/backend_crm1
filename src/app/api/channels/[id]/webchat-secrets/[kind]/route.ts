import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import { isWebchatSecretKind } from "@/lib/webchat/secrets";
import { rotateWebchatChannelSecret } from "@/services/channels";

const log = getLogger("api/channels/[id]/webchat-secrets/[kind]");

type RouteContext = { params: Promise<{ id: string; kind: string }> };

/**
 * POST /api/channels/:id/webchat-secrets/:kind — gera (1ª vez) ou gira o
 * segredo `identity` ou `s2s` do canal WEBCHAT. Exige `manage` no canal.
 * 201 `{ kind, secret, rotatedAt, secrets }`: `secret` em claro aparece SÓ
 * nesta resposta; o anterior deixa de valer na hora. Sem corpo.
 * docs/decisoes/webchat-widget.md §9.5.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id, kind } = await context.params;
    if (!isWebchatSecretKind(kind)) {
      return NextResponse.json(
        { message: 'Tipo de segredo inválido: use "identity" ou "s2s".' },
        { status: 400 },
      );
    }
    const denied = await requireChannelScope(session.user, "manage", id);
    if (denied) return denied;
    const result = await rotateWebchatChannelSecret(id, kind);
    if (!result) {
      return NextResponse.json({ message: "Canal Webchat não encontrado." }, { status: 404 });
    }
    return NextResponse.json(
      { kind, secret: result.secret, rotatedAt: result.rotatedAt, secrets: result.status },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e: unknown) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao gerar o segredo." }, { status: 500 });
  }
}
