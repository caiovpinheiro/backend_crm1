import { NextResponse } from "next/server";
import { z } from "zod";

import { userOrgFilter, withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  enableTelephony,
  disableTelephony,
  getProvisioningStatus,
  TELEPHONY_STATUS_IDLE,
} from "@/services/api4com/provisioning";

type RouteContext = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  enabled: z.boolean(),
});

type OrgSession = Parameters<Parameters<typeof withOrgContext>[0]>[0];

function denyNonAdmin(session: OrgSession) {
  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { message: "Acesso restrito a administradores." },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Resolve o usuário alvo respeitando o escopo de org da sessão
 * (super-admin EduIT sem org ativa enxerga todas — mesmo critério do
 * DELETE /api/users/:id). A org usada no provisionamento é a do ALVO,
 * não a da sessão: super-admin operando sem org ativa tem
 * session.organizationId=null e o getOrgIdOrThrow() explodia em 500.
 */
async function findTargetUser(userId: string, session: OrgSession) {
  return prisma.user.findFirst({
    where: { id: userId, ...userOrgFilter(session) },
    select: { id: true, organizationId: true },
  });
}

/**
 * PATCH /api/users/:id/telephony
 * Body: { "enabled": true|false }
 *
 * Provisiona ou desativa telefonia Api4com para o usuário informado.
 * Requer role ADMIN.
 *
 * Contexto vem de withOrgContext (runWithContext) — com requireAdmin,
 * que usa enterWith, o ALS não sobrevivia nesta rota em produção e
 * qualquer leitura de contexto explodia (mesmo bug já corrigido em
 * activity-feed/stats, analytics/*, pipelines/*).
 */
export async function PATCH(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = denyNonAdmin(session);
    if (denied) return denied;

    const { id: userId } = await context.params;

    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Body inválido. Esperado: { enabled: boolean }." },
        { status: 400 },
      );
    }

    const target = await findTargetUser(userId, session);
    if (!target?.organizationId) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    if (parsed.data.enabled) {
      const result = await enableTelephony(userId, target.organizationId);
      return NextResponse.json(
        { ...result, message: result.error },
        { status: result.success ? 200 : 500 },
      );
    }

    const result = await disableTelephony(userId, target.organizationId);
    return NextResponse.json(
      { ...result, message: result.error },
      { status: result.success ? 200 : 500 },
    );
  });
}

/**
 * GET /api/users/:id/telephony
 * Retorna status de provisionamento. A lista (`GET /api/users`) traz o
 * mesmo objeto em `telephony`, com a mesma regra de acesso (só ADMIN).
 */
export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = denyNonAdmin(session);
    if (denied) return denied;

    const { id: userId } = await context.params;

    const target = await findTargetUser(userId, session);
    if (!target?.organizationId) {
      return NextResponse.json({ message: "Usuário não encontrado." }, { status: 404 });
    }

    const status = await getProvisioningStatus(userId, target.organizationId);
    if (!status) {
      return NextResponse.json(TELEPHONY_STATUS_IDLE);
    }
    return NextResponse.json(status);
  });
}
