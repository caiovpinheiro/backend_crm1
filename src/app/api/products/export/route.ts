import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { csvDate, toCsv } from "@/lib/csv-stringify";
import { prisma } from "@/lib/prisma";

const MAX_ROWS = 100_000;

/**
 * GET /api/products/export?type=PRODUCT|SERVICE&active=false
 *
 * Exporta o catálogo de produtos/serviços em CSV. Cada linha = um item,
 * com colunas base + campos personalizados (`cf_*`). Os nomes de coluna
 * seguem o formato aceito pelo importador (`/api/products/import`),
 * permitindo round-trip (editar e reimportar para atualizar).
 *
 * Apenas ADMIN/MANAGER.
 */
export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem exportar dados." },
          { status: 403 },
        );
      }

      const { searchParams } = new URL(request.url);
      const typeParam = searchParams.get("type")?.toUpperCase();
      const activeOnly = searchParams.get("active") !== "false";

      const where: Record<string, unknown> = {};
      if (activeOnly) where.isActive = true;
      if (typeParam === "PRODUCT" || typeParam === "SERVICE") where.type = typeParam;

      const fieldDefs = await prisma.customField.findMany({
        where: { entity: "product" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });

      const products = await prisma.product.findMany({
        where,
        take: MAX_ROWS,
        orderBy: [{ name: "asc" }],
        include: { customValues: { select: { customFieldId: true, value: true } } },
      });

      const baseHeaders = [
        "id",
        "sku",
        "name",
        "description",
        "kind",
        "type",
        "price",
        "unit",
        "is_active",
        "track_stock",
        "stock",
        "created_at",
        "updated_at",
      ];
      const cfHeaders = fieldDefs.map((f) => `cf_${f.name}`);
      const headers = [...baseHeaders, ...cfHeaders];

      const rows = products.map((p) => {
        const cfMap = new Map(p.customValues.map((v) => [v.customFieldId, v.value]));
        const row: Record<string, unknown> = {
          id: p.id,
          sku: p.sku ?? "",
          name: p.name,
          description: p.description ?? "",
          kind: p.kind,
          type: p.type,
          price: p.price != null ? p.price.toString() : "0",
          unit: p.unit,
          is_active: p.isActive ? "true" : "false",
          track_stock: p.trackStock ? "true" : "false",
          stock: p.stock != null ? p.stock.toString() : "0",
          created_at: csvDate(p.createdAt),
          updated_at: csvDate(p.updatedAt),
        };
        for (const f of fieldDefs) {
          row[`cf_${f.name}`] = cfMap.get(f.id) ?? "";
        }
        return row;
      });

      const csv = toCsv(headers, rows);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `produtos-${stamp}.csv`;

      return new NextResponse("\ufeff" + csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Export-Total": String(products.length),
          "Access-Control-Expose-Headers":
            "Content-Disposition, X-Export-Total",
        },
      });
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao exportar produtos." }, { status: 500 });
  }
}
