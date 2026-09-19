import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  detectWabaProductCatalog,
  MetaCatalogPublishError,
  publishProductToMetaCatalog,
} from "@/services/meta-catalog";

type RouteContext = { params: Promise<{ id: string }> };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export async function GET(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:view");
    if (denied) return denied;

    const { id } = await context.params;
    const product = await prisma.product.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!product) {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }

    const links = await prisma.productMetaLink.findMany({
      where: { productId: product.id },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json({ links });
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:edit");
    if (denied) return denied;

    const { id } = await context.params;
    const product = await prisma.product.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!product) {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const rec = asRecord(body);
    const channelId = typeof rec.channelId === "string" ? rec.channelId.trim() : "";
    const productRetailerId =
      typeof rec.productRetailerId === "string" ? rec.productRetailerId.trim() : "";
    let metaCatalogId =
      typeof rec.metaCatalogId === "string" ? rec.metaCatalogId.trim() : "";

    if (!channelId) {
      return NextResponse.json({ message: "channelId é obrigatório." }, { status: 400 });
    }
    if (!productRetailerId) {
      return NextResponse.json(
        { message: "productRetailerId é obrigatório." },
        { status: 400 },
      );
    }

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, provider: "META_CLOUD_API" },
      select: { id: true },
    });
    if (!channel) {
      return NextResponse.json(
        { message: "Canal Meta Cloud API não encontrado." },
        { status: 400 },
      );
    }

    if (!metaCatalogId) {
      const detected = await detectWabaProductCatalog(channel.id);
      if (!detected.catalogId) {
        return NextResponse.json(
          {
            message: detected.message ?? "Não foi possível detectar o catálogo Meta.",
            reason: detected.reason,
          },
          { status: 400 },
        );
      }
      metaCatalogId = detected.catalogId;
    }

    const link = await prisma.productMetaLink.upsert({
      where: {
        productId_channelId: { productId: product.id, channelId: channel.id },
      },
      update: {
        metaCatalogId,
        productRetailerId,
        syncStatus: "MANUAL",
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
      create: withOrgFromCtx({
        productId: product.id,
        channelId: channel.id,
        metaCatalogId,
        productRetailerId,
        syncStatus: "MANUAL",
        lastSyncedAt: new Date(),
      }),
    });

    return NextResponse.json({ link });
  });
}

export async function POST(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:edit");
    if (denied) return denied;

    const { id } = await context.params;
    const product = await prisma.product.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!product) {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }

    let body: unknown = {};
    try {
      const text = await request.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const rec = asRecord(body);
    const channelId = typeof rec.channelId === "string" ? rec.channelId.trim() : "";
    const productRetailerId =
      typeof rec.productRetailerId === "string" ? rec.productRetailerId.trim() : "";

    try {
      const link = await publishProductToMetaCatalog({
        productId: product.id,
        channelId: channelId || undefined,
        productRetailerId: productRetailerId || undefined,
      });
      return NextResponse.json({ link });
    } catch (err) {
      if (err instanceof MetaCatalogPublishError) {
        return NextResponse.json(
          { message: err.message, reason: err.reason },
          { status: err.status },
        );
      }
      throw err;
    }
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:edit");
    if (denied) return denied;

    const { id } = await context.params;
    const url = new URL(request.url);
    const channelId = url.searchParams.get("channelId")?.trim() ?? "";
    if (!channelId) {
      return NextResponse.json({ message: "Informe ?channelId=." }, { status: 400 });
    }

    await prisma.productMetaLink.deleteMany({
      where: { productId: id, channelId },
    });
    return NextResponse.json({ ok: true });
  });
}
