import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

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
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
    ];
  }

  try {
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          courseConfig: {
            select: { level: true, mode: true, semester: true },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return NextResponse.json({ products, total, page, perPage });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao listar produtos.";
    return NextResponse.json({ message }, { status: 500 });
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
