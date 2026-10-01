/**
 * POST /api/me/sessions/revoke-all — "sair dos outros dispositivos" (ou de
 * todos).
 *
 * Incrementa `users.sessionVersion` (SV-1): todo JWT emitido antes passa a
 * responder 401 (`SESSION_REVOKED`) e os streams SSE do usuário são
 * fechados em todas as réplicas.
 *
 * Corpo (opcional): `{ "keepCurrent": boolean }`, default `true`.
 *   - `keepCurrent: true` (SV-2): a resposta traz `sessionRenewal` — prova
 *     de uso único (60 s) para ESTA sessão continuar. O cliente chama
 *     `update({ sessionRenewal: token })` do `useSession` e recebe o cookie
 *     na versão nova; as outras sessões caem. Cliente que ignora a prova
 *     (versão antiga do frontend) cai como as demais — o comportamento de
 *     antes.
 *   - `keepCurrent: false`: nenhuma prova; todas caem, inclusive esta, e o
 *     cliente deve ir para o login.
 *
 * Resposta: `{ ok: true, sessionVersion, sessionRenewal? }`. Rate limit por
 * sessão já vem do `requireAuth`.
 */
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { issueSessionRenewal } from "@/lib/auth/session-renewal";
import { revokeUserSessions } from "@/lib/auth/session-revocation";
import { sessionVersionFromClaim } from "@/lib/auth/session-version";

export const dynamic = "force-dynamic";

/** Corpo ausente, vazio ou inválido = default (manter a sessão atual). */
async function readKeepCurrent(request: Request): Promise<boolean> {
  try {
    const text = await request.text();
    if (!text.trim()) return true;
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const value = (body as { keepCurrent?: unknown }).keepCurrent;
      if (typeof value === "boolean") return value;
    }
  } catch {
    /* default */
  }
  return true;
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;

  const keepCurrent = await readKeepCurrent(request);

  try {
    const sessionVersion = await revokeUserSessions({
      userId: r.session.user.id,
      organizationId: r.session.user.organizationId ?? null,
      reason: "revoke_all",
    });
    const sessionRenewal = keepCurrent
      ? await issueSessionRenewal({
          userId: r.session.user.id,
          newVersion: sessionVersion,
          tokenVersion: sessionVersionFromClaim(r.session.user.sessionVersion),
        })
      : null;
    return NextResponse.json({
      ok: true,
      sessionVersion,
      ...(sessionRenewal ? { sessionRenewal } : {}),
    });
  } catch (e) {
    console.error("[POST /api/me/sessions/revoke-all]", e);
    return NextResponse.json(
      { message: "Não foi possível encerrar as sessões. Tente novamente." },
      { status: 500 },
    );
  }
}
