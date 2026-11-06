import { NextResponse } from "next/server";

import { getClientIp, withRateLimit } from "@/lib/rate-limit";
import { getClientView } from "@/services/remote-support/sessions";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/remote-support/:token
 *
 * Público (sem sessão): a página `/suporte/{token}` que o cliente abre. O
 * token aleatório da sessão é a única credencial. Devolve só o estado, o nome
 * da organização e o link do Assistant — nada do contato nem do atendente.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const rl = await withRateLimit({
    route: "GET /api/public/remote-support",
    profile: "remote-support.client",
    scope: "ip",
    id: getClientIp(request),
  });
  if (!rl.ok) return rl.response;

  const { token } = await ctx.params;
  const view = await getClientView(token);
  const headers = { ...rl.headers, "Cache-Control": "no-store" };
  if (!view) {
    return NextResponse.json({ message: "Link de suporte inválido." }, { status: 404, headers });
  }
  return NextResponse.json(view, { headers });
}
