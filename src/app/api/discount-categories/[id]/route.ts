/**
 * /api/discount-categories/[id] — GET / PATCH / DELETE (soft) de categoria.
 *
 * DELETE é soft (active=false). Quotas vinculadas continuam existindo; o
 * resolver de termos efetivos as trata como categoria inativa (cai no
 * fallback das colunas locais da cota).
 */
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

function toDateOrUndefined(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(request: Request, ctx: Ctx) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "quota:view");
    if (denied) return denied;

    const { id } = await ctx.params;
    const row = await prisma.discountCategory.findUnique({
      where: { id },
      include: {
        product: { select: { id: true, name: true } },
        quotas: {
          select: {
            id: true,
            orgUnitId: true,
            orgUnit: { select: { id: true, name: true } },
            qtyTotal: true,
            qtyConsumed: true,
            active: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!row) {
      return NextResponse.json(
        { message: "Categoria não encontrada." },
        { status: 404 },
      );
    }
    return NextResponse.json({
      category: {
        ...row,
        discountValue: Number(row.discountValue),
        quotas: row.quotas.map((q) => ({
          ...q,
          balance: q.qtyTotal === null ? null : q.qtyTotal - q.qtyConsumed,
        })),
      },
    });
  });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "quota:manage");
    if (denied) return denied;

    const { id } = await ctx.params;
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body.discountType === "PERCENT" || body.discountType === "FIXED") {
      patch.discountType = body.discountType;
    }
    if (body.discountValue !== undefined) {
      const v = Number(body.discountValue);
      if (!Number.isFinite(v) || v <= 0) {
        return NextResponse.json(
          { message: "Valor do desconto inválido." },
          { status: 400 },
        );
      }
      patch.discountValue = v;
    }
    if (body.productId !== undefined) {
      if (typeof body.productId === "string" && body.productId.trim()) {
        const productId = body.productId.trim();
        const p = await prisma.product.findUnique({
          where: { id: productId },
          select: { id: true },
        });
        if (!p) {
          return NextResponse.json(
            { message: "Produto não encontrado." },
            { status: 400 },
          );
        }
        patch.productId = productId;
      } else {
        patch.productId = null;
      }
    }
    if (body.exclusionGroup !== undefined) {
      patch.exclusionGroup =
        typeof body.exclusionGroup === "string" && body.exclusionGroup.trim()
          ? body.exclusionGroup.trim()
          : null;
    }
    if (body.maxStacks !== undefined) {
      patch.maxStacks = Math.max(1, Math.floor(Number(body.maxStacks)) || 1);
    }
    if (body.calcMode === "CASCADE" || body.calcMode === "SUM_SIMPLE") {
      patch.calcMode = body.calcMode;
    }
    const vf = toDateOrUndefined(body.validFrom);
    if (vf !== undefined) patch.validFrom = vf ?? new Date();
    const vt = toDateOrUndefined(body.validTo);
    if (vt !== undefined) patch.validTo = vt;
    if (body.active !== undefined) patch.active = body.active === true;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ message: "Nada a atualizar." }, { status: 400 });
    }

    try {
      await prisma.discountCategory.update({ where: { id }, data: patch });
    } catch {
      return NextResponse.json(
        { message: "Categoria não encontrada." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "quota:manage");
    if (denied) return denied;

    const { id } = await ctx.params;
    try {
      await prisma.discountCategory.update({
        where: { id },
        data: { active: false },
      });
    } catch {
      return NextResponse.json(
        { message: "Categoria não encontrada." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  });
}
