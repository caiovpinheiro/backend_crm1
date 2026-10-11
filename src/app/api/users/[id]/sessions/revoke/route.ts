/**
 * POST /api/users/[id]/sessions/revoke — admin encerra as sessões de outro
 * usuário da MESMA organização (ex.: aparelho perdido, desligamento).
 *
 * Permissão: a mesma da edição de usuários (`PUT /api/users/[id]`):
 * `requireAdmin()` + alvo escopado por `userOrgFilter` — usuário de outra
 * org responde 404, igual a id inexistente (não vaza existência).
 *
 * Efeito: `revokeUserSessions` com reason `admin_revoke` — incrementa
 * `users.sessionVersion` (todo JWT anterior passa a responder 401
 * `SESSION_REVOKED`), fecha os streams SSE do usuário em todas as réplicas
 * e grava o audit log `sessions_revoked`. Nenhuma prova de renovação: todas
 * as sessões do alvo caem. Rate limit: o mesmo do revoke-all (o por sessão
 * do `requireAuth`).
 *
 * Resposta: `{ ok: true, sessionVersion }`.
 */
import { NextResponse } from "next/server";

import { requireAdmin, userOrgFilter } from "@/lib/auth-helpers";
import { revokeUserSessions } from "@/lib/auth/session-revocation";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const log = getLogger("api/users/[id]/sessions/revoke");

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const r = await requireAdmin();
  if (!r.ok) return r.response;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ message: "ID inválido." }, { status: 400 });
  }

  try {
    const target = await prisma.user.findFirst({
      where: { id, type: "HUMAN", ...userOrgFilter(r.session) },
      select: { id: true, organizationId: true },
    });
    if (!target) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    const sessionVersion = await revokeUserSessions({
      userId: target.id,
      organizationId: target.organizationId ?? null,
      reason: "admin_revoke",
      actorId: r.session.user.id,
    });
    return NextResponse.json({ ok: true, sessionVersion });
  } catch (e) {
    log.error({ err: e, targetUserId: id }, "[POST /api/users/[id]/sessions/revoke] falhou");
    return NextResponse.json(
      { message: "Não foi possível encerrar as sessões. Tente novamente." },
      { status: 500 },
    );
  }
}
