import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { renderProductMessageForProduct } from "@/services/product-messages";

type Ctx = { params: Promise<{ id: string }> };

function num(v: string | null): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: Request, ctx: Ctx) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "product:view");
    if (denied) return denied;

    const { id } = await ctx.params;
    const url = new URL(request.url);
    const rendered = await renderProductMessageForProduct({
      productId: id,
      unitPrice: num(url.searchParams.get("unitPrice")),
      discount: num(url.searchParams.get("discount")),
      quantity: num(url.searchParams.get("quantity")),
    });
    return NextResponse.json(rendered);
  });
}
