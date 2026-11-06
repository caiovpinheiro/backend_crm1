import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  remoteSupportFail,
  requireOrgId,
  requireRemoteSupportWidget,
} from "@/services/remote-support/http";
import { createSessionControlLink } from "@/services/remote-support/sessions";

export const dynamic = "force-dynamic";

/** Link de controle da tela do cliente, com prazo. O cliente ainda precisa aceitar. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "remote_support:start");
  if (denied) return denied;
  const orgDeny = requireOrgId(r.session.user.organizationId);
  if (orgDeny) return orgDeny;
  const widgetDeny = await requireRemoteSupportWidget();
  if (widgetDeny) return widgetDeny;

  const { id } = await ctx.params;
  const guestName =
    r.session.user.name?.trim() || r.session.user.email?.trim() || "Atendente";
  try {
    return NextResponse.json(await createSessionControlLink(id, guestName));
  } catch (err) {
    return remoteSupportFail(err);
  }
}
