import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { respondWithCachedJson } from "@/lib/cache/response-cache";
import { getOrgSetting, setOrgSetting } from "@/lib/org-settings";
import {
  CARD_EXTENSION_SETTING_KEY,
  cardExtensionSpec,
  parseCardExtensionIds,
  resolveCardExtensionFields,
} from "@/services/startup-cache";

/** Definições da extensão, na ordem salva. Qualquer usuário autenticado lê. */
export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;
    return await runWithApiUserContext(authResult.user, async () => {
      // Cache por org + ETag/304 (`services/startup-cache.ts`).
      const spec = cardExtensionSpec(authResult.user);
      if (spec) return await respondWithCachedJson(request, spec);
      const fields = await resolveCardExtensionFields(
        parseCardExtensionIds(await getOrgSetting(CARD_EXTENSION_SETTING_KEY)),
      );
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
      const requested = parseCardExtensionIds(JSON.stringify(body.fieldIds));
      const fields = await resolveCardExtensionFields(requested);
      // `setOrgSetting` sobe a versão `org_settings` (invalida o cache da rota).
      await setOrgSetting(CARD_EXTENSION_SETTING_KEY, JSON.stringify(fields.map((field) => field.id)));
      return NextResponse.json(fields);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Erro ao salvar a extensão.";
      return NextResponse.json({ message }, { status: 500 });
    }
  });
}
