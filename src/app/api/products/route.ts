import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  parseProductWhatsAppSendMode,
  PRODUCT_WHATSAPP_SEND_MODE_KEY,
} from "@/lib/product-whatsapp-send-mode";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/products");

const ACCENT_FROM = "áàâãäåéèêëíìîïóòôõöúùûüýÿçñ";
const ACCENT_TO = "aaaaaaeeeeiiiiooooouuuuyycn";

function foldSearch(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[%_\\]/g, "");
}

/** Busca sem acento. Graduação primeiro, depois pós; cada grupo em ordem alfabética. */
async function searchProductIds(args: {
  search: string;
  activeOnly: boolean;
  typeFilter: string;
  kindFilter: string;
  catalogId: string;
  skip: number;
  take: number;
}): Promise<{ ids: string[]; total: number }> {
  const folded = foldSearch(args.search);
  if (!folded) return { ids: [], total: 0 };
  const orgId = getOrgIdOrThrow();
  const pattern = `%${folded}%`;
  const filters: Prisma.Sql[] = [Prisma.sql`p."organizationId" = ${orgId}`];
  if (args.activeOnly) filters.push(Prisma.sql`p."isActive" = true`);
  if (args.typeFilter === "PRODUCT" || args.typeFilter === "SERVICE") {
    filters.push(Prisma.sql`p.type = ${args.typeFilter}`);
  }
  if (
    args.kindFilter === "PHYSICAL" ||
    args.kindFilter === "SERVICE" ||
    args.kindFilter === "COURSE" ||
    args.kindFilter === "JOB_OPENING"
  ) {
    filters.push(Prisma.sql`p.kind::text = ${args.kindFilter}`);
  }
  if (args.catalogId) filters.push(Prisma.sql`p."catalogId" = ${args.catalogId}`);
  filters.push(Prisma.sql`(
    translate(lower(p.name), ${ACCENT_FROM}, ${ACCENT_TO}) LIKE ${pattern}
    OR translate(lower(coalesce(p.sku, '')), ${ACCENT_FROM}, ${ACCENT_TO}) LIKE ${pattern}
  )`);
  const where = Prisma.join(filters, " AND ");
  const [idRows, countRows] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM products p
      LEFT JOIN course_configs cc ON cc."productId" = p.id
      WHERE ${where}
      ORDER BY
        CASE cc.level::text
          WHEN 'GRADUATION' THEN 0
          WHEN 'POSTGRADUATE' THEN 1
          ELSE 2
        END,
        translate(lower(p.name), ${ACCENT_FROM}, ${ACCENT_TO})
      LIMIT ${args.take}
      OFFSET ${args.skip}
    `,
    prisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM products p
      WHERE ${where}
    `,
  ]);
  return {
    ids: idRows.map((r) => r.id),
    total: Number(countRows[0]?.total ?? 0),
  };
}

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return await runWithApiUserContext(authResult.user, async () => {
  const denied = await requirePermissionForUser(authResult.user, "product:view");
  if (denied) return denied;

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const activeOnly = url.searchParams.get("active") !== "false";
  const typeFilter = url.searchParams.get("type")?.toUpperCase();
  const kindFilter = url.searchParams.get("kind")?.toUpperCase();
  const catalogId = url.searchParams.get("catalogId")?.trim();
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const perPage = Math.min(1000, Math.max(1, Number(url.searchParams.get("perPage")) || 50));

  const where: Record<string, unknown> = {};
  if (activeOnly) where.isActive = true;
  if (typeFilter === "PRODUCT" || typeFilter === "SERVICE") where.type = typeFilter;
  if (
    kindFilter === "PHYSICAL" ||
    kindFilter === "SERVICE" ||
    kindFilter === "COURSE" ||
    kindFilter === "JOB_OPENING"
  ) {
    where.kind = kindFilter;
  }
  if (catalogId) where.catalogId = catalogId;
  const searched = search
    ? await searchProductIds({
        search,
        activeOnly,
        typeFilter,
        kindFilter,
        catalogId,
        skip: (page - 1) * perPage,
        take: perPage,
      })
    : null;
  if (searched) {
    where.id = { in: searched.ids.length > 0 ? searched.ids : ["__none__"] };
  }

  const productInclude = {
    courseConfig: {
      select: { level: true, mode: true, semester: true },
    },
    metaLinks: {
      select: {
        id: true,
        channelId: true,
        metaCatalogId: true,
        productRetailerId: true,
        syncStatus: true,
      },
    },
  } as const;

  try {
    let products;
    const listSkip = searched ? 0 : (page - 1) * perPage;
    const listTake = searched ? Math.max(searched.ids.length, 1) : perPage;
    const orderBy = searched ? undefined : ({ name: "asc" } as const);
    function sortSearched<T extends { id: string }>(rows: T[]): T[] {
      if (!searched) return rows;
      const rank = new Map(searched.ids.map((id, i) => [id, i]));
      return [...rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }
    try {
      const [rows, total] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy,
          skip: listSkip,
          take: listTake,
          include: productInclude,
        }),
        searched ? Promise.resolve(searched.total) : prisma.product.count({ where }),
      ]);
      products = { rows: sortSearched(rows), total };
    } catch (inner) {
      const raw = inner instanceof Error ? inner.message : "";
      if (!raw.includes("product_meta_links") && !raw.includes("metaLinks")) throw inner;
      const [rows, total] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy,
          skip: listSkip,
          take: listTake,
          include: {
            courseConfig: {
              select: { level: true, mode: true, semester: true },
            },
          },
        }),
        searched ? Promise.resolve(searched.total) : prisma.product.count({ where }),
      ]);
      products = {
        rows: sortSearched(rows.map((p) => ({ ...p, metaLinks: [] }))),
        total,
      };
    }

    const sendMode = parseProductWhatsAppSendMode(
      await getOrgSetting(PRODUCT_WHATSAPP_SEND_MODE_KEY),
    );
    return NextResponse.json({
      products: products.rows,
      total: products.total,
      page,
      perPage,
      sendMode,
    });
  } catch (e) {
    log.error({ err: e }, "[products] GET falhou");
    return NextResponse.json({ message: "Erro ao listar produtos." }, { status: 500 });
  }
  });
}

export async function POST(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return await runWithApiUserContext(authResult.user, async () => {
  const denied = await requirePermissionForUser(authResult.user, "product:create");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
  }

  const rawKind = typeof body.kind === "string" ? body.kind.toUpperCase() : "";
  const kind: "PHYSICAL" | "SERVICE" | "COURSE" | "JOB_OPENING" =
    rawKind === "SERVICE" ||
    rawKind === "COURSE" ||
    rawKind === "JOB_OPENING" ||
    rawKind === "PHYSICAL"
      ? (rawKind as "PHYSICAL" | "SERVICE" | "COURSE" | "JOB_OPENING")
      : (() => {
          // Retrocompat: cliente antigo manda apenas `type` (PRODUCT|SERVICE).
          const rawType =
            typeof body.type === "string" ? body.type.toUpperCase() : "PRODUCT";
          return rawType === "SERVICE" ? "SERVICE" : "PHYSICAL";
        })();

  // Campo legado `type` — mantém coerência p/ leitores antigos.
  const type = kind === "SERVICE" ? "SERVICE" : "PRODUCT";

  const trackStock = kind === "PHYSICAL" && body.trackStock === true;

  // CourseConfig (kind=COURSE)
  const courseModeRaw =
    typeof body.courseMode === "string" ? body.courseMode.toUpperCase() : "";
  const courseMode: "EAD" | "IN_PERSON" | "HYBRID" =
    courseModeRaw === "IN_PERSON" || courseModeRaw === "HYBRID"
      ? (courseModeRaw as "IN_PERSON" | "HYBRID")
      : "EAD";

  // catalogId opcional — valida pertença à org antes de vincular.
  let catalogId: string | null = null;
  if (typeof body.catalogId === "string" && body.catalogId.trim()) {
    const catalog = await prisma.catalog.findUnique({
      where: { id: body.catalogId.trim() },
      select: { id: true },
    });
    if (!catalog) {
      return NextResponse.json({ message: "Catálogo não encontrado." }, { status: 400 });
    }
    catalogId = catalog.id;
  }

  try {
    const product = await prisma.product.create({
      data: withOrgFromCtx({
        name,
        description: typeof body.description === "string" ? body.description.trim() || null : null,
        sku: typeof body.sku === "string" && body.sku.trim() ? body.sku.trim() : null,
        price: Number(body.price) || 0,
        unit:
          kind === "SERVICE"
            ? "serviço"
            : kind === "COURSE"
              ? "matrícula"
              : typeof body.unit === "string" && body.unit.trim()
                ? body.unit.trim()
                : "un",
        type,
        kind,
        catalogId,
        isActive: body.isActive !== false,
        trackStock,
        stock: trackStock ? Math.max(0, Number(body.stock) || 0) : 0,
      }),
    });

    if (kind === "COURSE") {
      await prisma.courseConfig.create({
        data: withOrgFromCtx({
          productId: product.id,
          mode: courseMode,
        }),
      });
    }

    return NextResponse.json({ product }, { status: 201 });
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e
        ? String((e as { code: unknown }).code)
        : "";
    const target = e && typeof e === "object" && "meta" in e
      ? (e as { meta?: { target?: string[] | string } }).meta?.target
      : undefined;
    const targetText = Array.isArray(target) ? target.join(",") : String(target ?? "");
    if (code === "P2002" && targetText.includes("sku")) {
      return NextResponse.json(
        { message: "Já existe um produto com este SKU." },
        { status: 409 },
      );
    }
    if (code === "P2002") {
      return NextResponse.json(
        { message: "Violação de unicidade ao criar produto." },
        { status: 409 },
      );
    }
    const message = e instanceof Error ? e.message : "Erro ao criar produto.";
    return NextResponse.json({ message }, { status: 500 });
  }
  });
}
