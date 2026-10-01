import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/losses");

function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object" && v !== null && "toNumber" in v) {
    const d = v as { toNumber: () => number };
    if (typeof d.toNumber === "function") return d.toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(request: Request) {
  try {
    // Aceita sessao (cockpit) e Bearer API token (integracoes/n8n) — mesmo
    // helper de GET /api/deals.
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    // Super-admin nao tem organizationId — ele acessa o painel /admin global
    // por outro caminho. Aqui exigimos org pra evitar agregado cross-tenant.
    const orgId = authResult.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Sem organizacao no contexto." },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(request.url);
    const fromS = searchParams.get("from");
    const toS = searchParams.get("to");

    // from/to independentes — o caller pode informar so um lado do intervalo.
    let dateFilter = Prisma.sql`TRUE`;
    const from = fromS ? new Date(fromS) : null;
    const to = toS ? new Date(toS) : null;
    const fromOk = from !== null && !Number.isNaN(from.getTime());
    const toOk = to !== null && !Number.isNaN(to.getTime());
    if (fromOk && toOk) {
      dateFilter = Prisma.sql`d."closedAt" >= ${from} AND d."closedAt" <= ${to}`;
    } else if (fromOk) {
      dateFilter = Prisma.sql`d."closedAt" >= ${from}`;
    } else if (toOk) {
      dateFilter = Prisma.sql`d."closedAt" <= ${to}`;
    }

    const rows = await prisma.$queryRaw<
      { reason: string; count: bigint; total_value: unknown }[]
    >(Prisma.sql`
      SELECT
        COALESCE(NULLIF(TRIM(d."lostReason"), ''), '(sem motivo)') AS reason,
        COUNT(*)::bigint AS count,
        COALESCE(SUM(CAST(d.value AS DECIMAL)), 0) AS total_value
      FROM deals d
      WHERE d.status = 'LOST'::"DealStatus"
        AND d."organizationId" = ${orgId}
        AND ${dateFilter}
      GROUP BY reason
      ORDER BY count DESC
    `);

    const items = rows.map((r) => ({
      reason: r.reason,
      count: Number(r.count),
      totalValue: Math.round(toNumber(r.total_value) * 100) / 100,
    }));

    const totalLost = items.reduce((s, i) => s + i.count, 0);
    const totalValue = items.reduce((s, i) => s + i.totalValue, 0);

    return NextResponse.json({ items, totalLost, totalValue: Math.round(totalValue * 100) / 100 });
    });
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: "Erro ao carregar motivos de perda." },
      { status: 500 },
    );
  }
}
