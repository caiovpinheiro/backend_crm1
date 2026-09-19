import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  getContactCustomFieldValues,
  upsertContactCustomFieldValues,
} from "@/services/custom-fields";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/services/activity-log";

type Ctx = { params: Promise<{ id: string }> };

// Bug 27/mai/26: usava `withOrgContext`, que só lê cookie do NextAuth.
// Bearer tokens (n8n, integrações server-to-server) recebiam 401 mesmo
// com token válido. Migrado para o par `authenticateApiRequest` +
// `runWithApiUserContext` — mesmo padrão de `/api/contacts/route.ts`,
// aceita Bearer e sessão.
export async function GET(request: Request, ctx: Ctx) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const denied = await requirePermissionForUser(authResult.user, "contact:view");
      if (denied) return denied;

      const { id } = await ctx.params;
      const values = await getContactCustomFieldValues(id);
      return NextResponse.json(values);
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
      const denied = await requirePermissionForUser(authResult.user, "contact:edit");
      if (denied) return denied;

      const { id } = await ctx.params;
      const body = (await request.json()) as Record<string, unknown>;
      const values = Array.isArray(body.values) ? body.values : [];
      const cleaned = values.filter(
        (v): v is { fieldId: string; value: string } =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as Record<string, unknown>).fieldId === "string" &&
          typeof (v as Record<string, unknown>).value === "string",
      );
      const prev = await getContactCustomFieldValues(id);
      const prevByField = new Map(
        prev.map((v) => [
          (v as { fieldId?: string }).fieldId ?? "",
          (v as { value?: string }).value ?? "",
        ]),
      );

      await upsertContactCustomFieldValues(id, cleaned);
      const updated = await getContactCustomFieldValues(id);

      // Emite 1 evento por campo que realmente mudou.
      const fieldIds = cleaned.map((c) => c.fieldId);
      const fields =
        fieldIds.length > 0
          ? await prisma.customField.findMany({
              where: { id: { in: fieldIds } },
              select: { id: true, label: true },
            })
          : [];
      const labelById = new Map(fields.map((f) => [f.id, f.label]));
      const contact = await prisma.contact.findUnique({
        where: { id },
        select: { name: true, phone: true, email: true },
      });
      for (const c of cleaned) {
        const before = prevByField.get(c.fieldId) ?? "";
        if (before === c.value) continue;
        void logEvent({
          type: "CONTACT_FIELD_CHANGED",
      actorType: "HUMAN",
          entityType: "CONTACT",
          entityId: id,
          entityLabel: contact?.name ?? contact?.phone ?? contact?.email ?? null,
          contactId: id,
          field: labelById.get(c.fieldId) ?? c.fieldId,
          oldValue: before || null,
          newValue: c.value || null,
          meta: {
            fieldId: c.fieldId,
            fieldLabel: labelById.get(c.fieldId) ?? null,
            custom: true,
          },
        });
      }

      return NextResponse.json(updated);
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro." },
      { status: 500 },
    );
  }
}
