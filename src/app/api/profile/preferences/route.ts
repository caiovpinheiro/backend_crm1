/**
 * GET /api/profile/preferences
 * Preferencias pessoais: `sidebar` (papel + overlay), `dashboard`,
 * `appearance`. Tambem devolve `roleSidebar` (teto do papel) e
 * `availableKeys` (permission + widgets ativos).
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getActiveWidgetSlugs } from "@/services/organization-widgets";
import {
  computeAvailableKeys,
  getAppearancePreferences,
  getDashboardPreferences,
  getSidebarPreferenceBundle,
} from "@/services/user-preferences";

export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const ctx = await loadAuthzContext({
        userId: session.user.id,
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
      });
      const activeSlugs = await getActiveWidgetSlugs();
      const availableKeys = computeAvailableKeys(
        (key) => can(ctx, key),
        (slug) => activeSlugs.has(slug),
      );

      const [sidebarBundle, dashboard, appearance] = await Promise.all([
        getSidebarPreferenceBundle(session.user.id, availableKeys),
        getDashboardPreferences(session.user.id),
        getAppearancePreferences(session.user.id),
      ]);
      return NextResponse.json({
        sidebar: sidebarBundle.sidebar,
        roleSidebar: sidebarBundle.roleSidebar,
        dashboard,
        appearance,
        availableKeys: [...availableKeys],
      });
    } catch (e) {
      console.error("[GET /api/profile/preferences]", e);
      return NextResponse.json(
        { message: "Erro ao carregar preferências." },
        { status: 500 },
      );
    }
  });
}
