import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull } from "@/lib/request-context";
import { listSystemActivitySessions } from "@/services/system-activity";

import { parsePeriod } from "../../_period";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/logs/system-usage/[userId]/sessions");

export const dynamic = "force-dynamic";

/**
 * GET /api/logs/system-usage/:userId/sessions?from=&to=&cursor=&limit=
 *
 * Histórico detalhado paginado de sessões de USO REAL de um usuário.
 * Restrito a ADMIN/MANAGER; usuário obrigatoriamente da mesma organização.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }
    const orgId = getOrgIdOrNull();
    if (!orgId) {
      return NextResponse.json({ items: [], nextCursor: null });
    }

    const { userId } = await params;
    if (!userId) {
      return NextResponse.json(
        { message: "userId obrigatório." },
        { status: 400 },
      );
    }

    // Confirma que o usuário pertence à org da sessão (defesa em profundidade).
    const owner = await prismaBase.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: { id: true },
    });
    if (!owner) {
      return NextResponse.json(
        { message: "Usuário não encontrado nesta organização." },
        { status: 404 },
      );
    }

    const { searchParams } = new URL(request.url);
    const period = parsePeriod(searchParams);
    if (!period.ok) {
      return NextResponse.json({ message: period.message }, { status: 400 });
    }

    const cursor = searchParams.get("cursor");
    const limitRaw = Number(searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

    try {
      const result = await listSystemActivitySessions({
        organizationId: orgId,
        userId,
        from: period.from,
        to: period.to,
        cursor: cursor ?? null,
        limit,
      });
      return NextResponse.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("system_activity_sessions")) {
        return NextResponse.json({
          items: [],
          nextCursor: null,
          pending: true,
        });
      }
      log.error({ err }, "[logs/system-usage/sessions] erro");
      return NextResponse.json(
        { message: "Erro ao carregar sessões." },
        { status: 500 },
      );
    }
  });
}
