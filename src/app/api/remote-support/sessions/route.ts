import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  remoteSupportFail,
  requireOrgId,
  requireRemoteSupportWidget,
} from "@/services/remote-support/http";
import { listContactSessions, startSession } from "@/services/remote-support/sessions";

export const dynamic = "force-dynamic";

/** Histórico de suporte remoto de um contato (`?contactId=` — CUID ou número). */
export async function GET(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "remote_support:view");
  if (denied) return denied;
  const orgDeny = requireOrgId(r.session.user.organizationId);
  if (orgDeny) return orgDeny;
  const widgetDeny = await requireRemoteSupportWidget();
  if (widgetDeny) return widgetDeny;

  const contactId = new URL(request.url).searchParams.get("contactId")?.trim();
  if (!contactId) {
    return NextResponse.json({ message: "contactId obrigatório." }, { status: 400 });
  }
  try {
    return NextResponse.json({ items: await listContactSessions(contactId) });
  } catch (err) {
    return remoteSupportFail(err);
  }
}

/** Inicia (ou reaproveita a ativa) uma sessão para o contato. Body: `{ contactId }`. */
export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "remote_support:start");
  if (denied) return denied;
  const orgDeny = requireOrgId(r.session.user.organizationId);
  if (orgDeny) return orgDeny;
  const widgetDeny = await requireRemoteSupportWidget();
  if (widgetDeny) return widgetDeny;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
  if (!contactId) {
    return NextResponse.json({ message: "contactId obrigatório." }, { status: 400 });
  }

  try {
    const session = await startSession({
      orgId: r.session.user.organizationId!,
      userId: r.session.user.id,
      contactIdOrNumber: contactId,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    return remoteSupportFail(err);
  }
}
