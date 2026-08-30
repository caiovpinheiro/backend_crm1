/**
 * PATCH /api/profile/preferences/sidebar
 *
 * Overlay pessoal da NavRail (ordem + ocultacao). O teto continua sendo
 * a uniao dos `sidebarItems` do papel — o usuario nao reexibe o que o
 * admin escondeu. Body:
 *   { items: [{ key, enabled, order }] }  — salva o overlay
 *   { reset: true }                       — apaga o overlay (volta ao papel)
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getActiveWidgetSlugs } from "@/services/organization-widgets";
import {
  clearSidebarPreferences,
  computeAvailableKeys,
  saveSidebarPreferences,
} from "@/services/user-preferences";

const itemSchema = z.object({
  key: z.string().min(1).max(100),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(1000),
});

const bodySchema = z
  .object({
    items: z.array(itemSchema).max(100).optional(),
    reset: z.boolean().optional(),
  })
  .refine((data) => data.reset === true || Array.isArray(data.items), {
    message: "Informe items ou reset.",
  });

async function resolveAvailableKeys(session: {
  user: { id: string; organizationId: string | null; isSuperAdmin: boolean };
}) {
  const ctx = await loadAuthzContext({
    userId: session.user.id,
    organizationId: session.user.organizationId,
    isSuperAdmin: session.user.isSuperAdmin,
  });
  const activeSlugs = await getActiveWidgetSlugs();
  return computeAvailableKeys(
    (key) => can(ctx, key),
    (slug) => activeSlugs.has(slug),
  );
}

export async function PATCH(request: Request) {
  return withOrgContext(async (session) => {
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const availableKeys = await resolveAvailableKeys(session);
      const bundle = parsed.data.reset
        ? await clearSidebarPreferences(session.user.id, availableKeys)
        : await saveSidebarPreferences(
            session.user.id,
            parsed.data.items ?? [],
            availableKeys,
          );
      return NextResponse.json({
        sidebar: bundle.sidebar,
        roleSidebar: bundle.roleSidebar,
        availableKeys: [...availableKeys],
      });
    } catch (e) {
      console.error("[PATCH /api/profile/preferences/sidebar]", e);
      return NextResponse.json(
        { message: "Erro ao salvar o menu." },
        { status: 500 },
      );
    }
  });
}
