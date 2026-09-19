import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  canEditFieldForUser,
  loadScopedPolicy,
  requirePermissionForUser,
} from "@/lib/authz/resource-policy";
import { canAccessField } from "@/lib/authz/scope-grants";
import { prisma } from "@/lib/prisma";
import {
  getDealCustomFieldValues,
  upsertDealCustomFieldValuesTx,
} from "@/services/custom-fields";
import { createDealEventTx, getDealById } from "@/services/deals";

type Ctx = { params: Promise<{ id: string }> };

// Bug 27/mai/26: usava `withOrgContext`, que só lê cookie do NextAuth.
// Bearer tokens (n8n, integrações server-to-server) recebiam 401 mesmo
// com token válido. Migrado para o par `authenticateApiRequest` +
// `runWithApiUserContext` — mesmo padrão de `/api/deals/route.ts`,
// aceita Bearer e sessão.
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
      const values = await getDealCustomFieldValues(existing.id);
      const policy = await loadScopedPolicy(authResult.user);
      const visible = values.filter((item) => {
        if (!policy.enabled) return true;
        return canAccessField({
          grants: policy.grants,
          role: authResult.user.role,
          entity: "deal",
          action: "view",
          fieldKey: item.fieldId,
        });
      });
      return NextResponse.json(visible);
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}

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
      const dealId = existing.id;
      const body = (await request.json()) as Record<string, unknown>;
      const values = Array.isArray(body.values) ? body.values : [];
      const cleaned = values.filter(
        (v): v is { fieldId: string; value: string } =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as Record<string, unknown>).fieldId === "string" &&
          typeof (v as Record<string, unknown>).value === "string",
      );
      const blocked = [];
      for (const item of cleaned) {
        const allowed = await canEditFieldForUser(authResult.user, "deal", item.fieldId);
        if (!allowed) blocked.push(item.fieldId);
      }
      if (blocked.length > 0) {
        return NextResponse.json(
          { message: "Sem permissão para editar alguns campos.", blockedFieldIds: blocked },
          { status: 403 },
        );
      }
      const oldValues = await getDealCustomFieldValues(dealId);
      const uid = authResult.user.id;
      const fieldIds = cleaned.map((c) => c.fieldId);
      const fieldDefs = await prisma.customField.findMany({
        where: { id: { in: fieldIds } },
        select: { id: true, label: true },
      });
      const labelMap = new Map(fieldDefs.map((f) => [f.id, f.label]));
      const oldMap = new Map(
        (oldValues as { fieldId: string; value: string }[]).map((v) => [v.fieldId, v.value]),
      );

      const updated = await prisma.$transaction(async (tx) => {
        await upsertDealCustomFieldValuesTx(tx, dealId, cleaned);

        for (const item of cleaned) {
          const prev = oldMap.get(item.fieldId) ?? "";
          if (prev !== item.value) {
            await createDealEventTx(
              tx,
              dealId,
              uid,
              "CUSTOM_FIELD_UPDATED",
              {
                fieldLabel: labelMap.get(item.fieldId) ?? item.fieldId,
                from: prev,
                to: item.value,
              },
            );
          }
        }

        return getDealCustomFieldValues(dealId);
      });

      return NextResponse.json(updated);
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}
