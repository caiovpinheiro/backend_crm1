/**
 * GET /api/users/[id]/effective-permissions
 *
 * Retorna as permissões efetivas do usuário no contexto da organização.
 * Usado pelo frontend (use-my-permissions.ts / useCan) para controle de
 * acesso no cliente.
 *
 * Estrutura de retorno:
 *   { permissions, channelGrants, stageGrants, roles, groups }
 *
 * - ADMIN / super-admin recebem permissions = ["*"] (acesso total).
 * - Usuário consulta as próprias permissões; ADMIN da mesma org vê as de colegas.
 * - Super-admin sem org ativa pode auditar outra org (plataforma). Com org
 *   ativa, `userOrgFilter` restringe à sessão — igual às rotas de Equipe.
 *
 * O cálculo em si vive em `services/effective-permissions.ts` (compartilhado
 * com `GET /api/me/bootstrap`).
 */

import { NextResponse } from "next/server";

import { withOrgContext, userOrgFilter } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { prismaBase } from "@/lib/prisma-base";
import { computeEffectivePermissions } from "@/services/effective-permissions";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await ctx.params;

      const requesterId = session.user.id;
      const requesterCtx = await loadAuthzContext({
        userId: requesterId,
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
      });
      const canAuditOthers = can(requesterCtx, "settings:permissions");
      if (requesterId !== id && !canAuditOthers) {
        return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
      }

      const user = await prismaBase.user.findFirst({
        where: { id, ...userOrgFilter(session) },
        select: {
          id: true,
          role: true,
          organizationId: true,
          isSuperAdmin: true,
        },
      });

      if (!user) {
        return NextResponse.json(
          { message: "Usuário não encontrado." },
          { status: 404 },
        );
      }

      const payload = await computeEffectivePermissions(user);
      return NextResponse.json(payload);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
