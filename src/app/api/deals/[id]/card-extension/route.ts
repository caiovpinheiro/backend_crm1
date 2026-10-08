import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  canEditFieldForUser,
  canViewFieldForUser,
  requirePermissionForUser,
} from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import {
  listDealCardExtensionValues,
  loadExtensionFieldIds,
  upsertDealCardExtensionValues,
} from "@/services/card-extension-values";
import { getDealById } from "@/services/deals";

type Ctx = { params: Promise<{ id: string }> };

/** Valores da extensão deste negócio. Não lê o valor do card de cima. */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:view");
      if (denied) return denied;
      const { id } = await ctx.params;
      const existing = await getDealById(id);
      if (!existing) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
      const values = await listDealCardExtensionValues(existing.id);
      const ids = values.map((item) => item.fieldId);
      const defs = ids.length
        ? await prisma.customField.findMany({
            where: { id: { in: ids } },
            select: { id: true, entity: true },
          })
        : [];
      const entityById = new Map(defs.map((row) => [row.id, row.entity]));
      const visible = [];
      for (const item of values) {
        const entity = entityById.get(item.fieldId);
        if (entity !== "deal" && entity !== "contact") continue;
        const allowed = await canViewFieldForUser(authResult.user, entity, item.fieldId);
        if (allowed) visible.push(item);
      }
      return NextResponse.json(visible);
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}

/** Grava o valor da extensão. O campo do card de cima permanece como está. */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "deal:edit");
      if (denied) return denied;
      const { id } = await ctx.params;
      const existing = await getDealById(id);
      if (!existing) return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      const values = Array.isArray(body.values) ? body.values : [];
      const cleaned = values.filter(
        (item): item is { fieldId: string; value: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).fieldId === "string" &&
          typeof (item as Record<string, unknown>).value === "string",
      );
      const allowed = new Set(await loadExtensionFieldIds());
      const unknown = cleaned.filter((item) => !allowed.has(item.fieldId));
      if (unknown.length > 0) {
        return NextResponse.json(
          { message: "Campo fora da extensão de card." },
          { status: 400 },
        );
      }
      const defs = cleaned.length
        ? await prisma.customField.findMany({
            where: { id: { in: cleaned.map((item) => item.fieldId) } },
            select: { id: true, entity: true },
          })
        : [];
      const entityById = new Map(defs.map((row) => [row.id, row.entity]));
      const blocked: string[] = [];
      for (const item of cleaned) {
        const entity = entityById.get(item.fieldId);
        if (entity !== "deal" && entity !== "contact") {
          blocked.push(item.fieldId);
          continue;
        }
        const ok = await canEditFieldForUser(authResult.user, entity, item.fieldId);
        if (!ok) blocked.push(item.fieldId);
      }
      if (blocked.length > 0) {
        return NextResponse.json(
          { message: "Sem permissão para editar alguns campos.", blockedFieldIds: blocked },
          { status: 403 },
        );
      }
      await upsertDealCardExtensionValues(existing.id, cleaned);
      return NextResponse.json(await listDealCardExtensionValues(existing.id));
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}
