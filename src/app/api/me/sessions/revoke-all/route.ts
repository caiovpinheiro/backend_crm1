/**
 * POST /api/me/sessions/revoke-all — "sair de todos os dispositivos".
 *
 * Incrementa `users.sessionVersion` (SV-1): todo JWT emitido antes —
 * inclusive o desta chamada — passa a responder 401 (`SESSION_REVOKED`)
 * e os streams SSE do usuário são fechados em todas as réplicas. O
 * cliente deve ir para o login em seguida. Não há "exceto este
 * dispositivo": a sessão é um JWT sem estado e o cookie não é reemitido
 * por rotas de API; o caminho simples e previsível é derrubar tudo.
 *
 * Resposta: `{ ok: true, sessionVersion }` (versão nova). Rate limit por
 * sessão já vem do `requireAuth`.
 */
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { revokeUserSessions } from "@/lib/auth/session-revocation";

export const dynamic = "force-dynamic";

export async function POST() {
  const r = await requireAuth();
  if (!r.ok) return r.response;

  try {
    const sessionVersion = await revokeUserSessions({
      userId: r.session.user.id,
      organizationId: r.session.user.organizationId ?? null,
      reason: "revoke_all",
    });
    return NextResponse.json({ ok: true, sessionVersion });
  } catch (e) {
    console.error("[POST /api/me/sessions/revoke-all]", e);
    return NextResponse.json(
      { message: "Não foi possível encerrar as sessões. Tente novamente." },
      { status: 500 },
    );
  }
}
