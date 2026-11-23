import { Prisma } from "@prisma/client";
const Decimal = Prisma.Decimal;
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { isRegisteredPrice, readPriceOptions } from "@/services/deal-product-price-sync";
import { createDealEvent, getDealById } from "@/services/deals";

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

// Bug 30/jun/26: PUT/DELETE usavam `auth()` direto, igual o bug 27/abr/26
// descrito no irmão `products/route.ts`. `getDealById()` chama
// `getOrgIdOrThrow()` (ALS context), que só é populado por `withOrgContext`
// / `runWithContext`. Sem isso, exclusão/edição de produto do deal
// estouravam 500 silencioso (frontend engolia o erro e o item ficava
// na lista). Migrado para `withOrgContext`, mesmo padrão de GET/POST.

async function recalcDealValue(dealId: string) {
  const items = await prisma.dealProduct.findMany({
    where: { dealId },
    select: { quantity: true, unitPrice: true, discount: true },
  });

  let total = new Decimal(0);
  for (const item of items) {
    const qty = new Decimal(item.quantity);
    const price = new Decimal(item.unitPrice);
    const disc = new Decimal(item.discount);
    total = total.plus(qty.mul(price).mul(new Decimal(100).minus(disc).div(100)));
  }

  await prisma.deal.update({
    where: { id: dealId },
    data: { value: total },
  });
}

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const { id, itemId } = await context.params;
    const existingDeal = await getDealById(id);
    if (!existingDeal) {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }
    const dealId = existingDeal.id;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const existing = await prisma.dealProduct.findUnique({
      where: { id: itemId, dealId },
      include: {
        product: {
          select: { type: true, price: true, courseConfig: { select: { pricingOptions: true } } },
        },
      },
    });
    if (!existing) return NextResponse.json({ message: "Item não encontrado." }, { status: 404 });

    const isService = existing.product.type === "SERVICE";

    const data: Record<string, unknown> = {};
    if (!isService) {
      if (typeof body.quantity === "number" || typeof body.quantity === "string") {
        data.quantity = Math.max(0.01, Number(body.quantity) || 1);
      }
      if (typeof body.unitPrice === "number" || typeof body.unitPrice === "string") {
        data.unitPrice = Number(body.unitPrice) || 0;
      }
      if (typeof body.discount === "number" || typeof body.discount === "string") {
        data.discount = Math.min(100, Math.max(0, Number(body.discount) || 0));
      }
    }

    // Sem `product:edit_deal_price`: só trocar entre as cotas cadastradas
    // (preço + desconto de uma cota), sem mexer na quantidade.
    const nextPrice = data.unitPrice !== undefined ? Number(data.unitPrice) : Number(existing.unitPrice);
    const nextDiscount = data.discount !== undefined ? Number(data.discount) : Number(existing.discount);
    const qtyChanged =
      data.quantity !== undefined && Number(data.quantity) !== Number(existing.quantity);
    const priceChanged =
      (data.unitPrice !== undefined || data.discount !== undefined) &&
      (nextPrice !== Number(existing.unitPrice) || nextDiscount !== Number(existing.discount));
    const freePrice =
      priceChanged &&
      !isRegisteredPrice(
        readPriceOptions(existing.product.price, existing.product.courseConfig?.pricingOptions),
        nextPrice,
        nextDiscount,
      );
    if (qtyChanged || freePrice) {
      const denied = await requirePermissionForUser(session.user, "product:edit_deal_price");
      if (denied) return denied;
    }

    try {
      const item = await prisma.dealProduct.update({
        where: { id: itemId, dealId },
        data,
        include: { product: { select: { id: true, name: true, sku: true, unit: true, type: true } } },
      });

      await recalcDealValue(dealId);

      const lineTotal = Number(
        new Decimal(item.quantity)
          .mul(new Decimal(item.unitPrice))
          .mul(new Decimal(100).minus(new Decimal(item.discount)).div(100))
      );

      const uid = (session.user as { id: string }).id;
      createDealEvent(dealId, uid, "PRODUCT_UPDATED", {
        productName: item.product.name,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
      }).catch(() => {});

      return NextResponse.json({
        item: {
          id: item.id,
          productId: item.productId,
          productName: item.product.name,
          productSku: item.product.sku,
          unit: item.product.unit,
          productType: item.product.type as "PRODUCT" | "SERVICE",
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount),
          total: lineTotal,
          createdAt: item.createdAt.toISOString(),
        },
      });
    } catch {
      return NextResponse.json({ message: "Item não encontrado." }, { status: 404 });
    }
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const { id, itemId } = await context.params;
    const existingDeal = await getDealById(id);
    if (!existingDeal) {
      return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
    }
    const dealId = existingDeal.id;

    try {
      const item = await prisma.dealProduct.findUnique({
        where: { id: itemId, dealId },
        include: { product: { select: { name: true } } },
      });
      await prisma.dealProduct.delete({ where: { id: itemId, dealId } });
      await recalcDealValue(dealId);

      const uid = (session.user as { id: string }).id;
      createDealEvent(dealId, uid, "PRODUCT_REMOVED", { productName: item?.product?.name ?? "?" }).catch(() => {});

      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ message: "Item não encontrado." }, { status: 404 });
    }
  });
}
