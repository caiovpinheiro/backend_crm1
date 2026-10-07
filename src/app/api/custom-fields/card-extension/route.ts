import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getOrgSetting, setOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";

const KEY = "customFields.cardExtension";

type ExtensionField = {
  id: string;
  label: string;
  entity: string;
  type: string;
  options: string[];
};

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

async function resolveFields(ids: string[]): Promise<ExtensionField[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.customField.findMany({
    where: { id: { in: ids }, entity: { in: ["deal", "contact"] } },
    select: { id: true, label: true, entity: true, type: true, options: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        label: row.label,
        entity: row.entity,
        type: row.type,
        options: row.options,
      },
    ];
  });
}

/** Definições da extensão, na ordem salva. Qualquer usuário autenticado lê. */
export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;
    return await runWithApiUserContext(authResult.user, async () => {
      const fields = await resolveFields(parseIds(await getOrgSetting(KEY)));
      return NextResponse.json(fields);
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao ler a extensão.";
    return NextResponse.json({ message }, { status: 500 });
  }
}

/** Substitui a lista. Ids de outra org ou que não são campo de negócio/contato saem. */
export async function PUT(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const denied = await requirePermissionForUser(
        session.user as {
          id: string;
          organizationId: string | null;
          role?: string | null;
          isSuperAdmin?: boolean;
        },
        "settings:custom_fields",
      );
      if (denied) return denied;
      const body = (await request.json().catch(() => ({}))) as { fieldIds?: unknown };
      if (!Array.isArray(body.fieldIds)) {
        return NextResponse.json({ message: "fieldIds é obrigatório." }, { status: 400 });
      }
      const requested = parseIds(JSON.stringify(body.fieldIds));
      const fields = await resolveFields(requested);
      await setOrgSetting(KEY, JSON.stringify(fields.map((field) => field.id)));
      return NextResponse.json(fields);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Erro ao salvar a extensão.";
      return NextResponse.json({ message }, { status: 500 });
    }
  });
}
