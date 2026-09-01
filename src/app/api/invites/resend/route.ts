import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { resendOrganizationInvite } from "@/services/invites";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json({ message: "Sem organização." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const inviteId = typeof b.inviteId === "string" ? b.inviteId : "";
  if (!inviteId) {
    return NextResponse.json({ message: "inviteId é obrigatório." }, { status: 400 });
  }

  try {
    const invite = await resendOrganizationInvite({
      organizationId: orgId,
      inviteId,
      actorId: r.session.user.id,
    });
    return NextResponse.json({
      id: invite.id,
      email: invite.email,
      expiresAt: invite.expiresAt,
      sent: invite.sent,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro ao reenviar convite.";
    return NextResponse.json({ message: msg }, { status: 400 });
  }
}
