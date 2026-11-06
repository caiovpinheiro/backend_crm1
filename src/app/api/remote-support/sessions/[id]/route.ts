import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  remoteSupportFail,
  requireOrgId,
  requireRemoteSupportWidget,
} from "@/services/remote-support/http";
import { refreshSession } from "@/services/remote-support/sessions";

export const dynamic = "force-dynamic";

/** Estado da sessão — confere no MeshCentral se o cliente já conectou. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "remote_support:view");
  if (denied) return denied;
  const orgDeny = requireOrgId(r.session.user.organizationId);
  if (orgDeny) return orgDeny;
  const widgetDeny = await requireRemoteSupportWidget();
  if (widgetDeny) return widgetDeny;

  const { id } = await ctx.params;
  try {
    return NextResponse.json({ session: await refreshSession(id) });
  } catch (err) {
    return remoteSupportFail(err);
  }
}
