import { UserRole } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { CRM_ACTION_KEYS, type CrmActionKey } from "@/lib/authz/scope-grants";
import {
  issueOrganizationInvite,
  listPendingInvites,
  type PendingCrmActions,
} from "@/services/invites";

export const runtime = "nodejs";

export async function GET() {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json({ message: "Sem organização." }, { status: 400 });
  }
  const invites = await listPendingInvites(orgId);
  return NextResponse.json({ invites });
}

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
  const email = typeof b.email === "string" ? b.email : "";
  const inviteeName = typeof b.name === "string" ? b.name : "";
  const roleRaw = typeof b.role === "string" ? b.role : UserRole.MEMBER;
  const role = Object.values(UserRole).includes(roleRaw as UserRole)
    ? (roleRaw as UserRole)
    : UserRole.MEMBER;
  const pendingRoleId = typeof b.roleId === "string" ? b.roleId : null;

  let pendingCrmActions: PendingCrmActions | null = null;
  if (b.crmActions && typeof b.crmActions === "object") {
    const src = b.crmActions as Record<string, unknown>;
    const parsed: PendingCrmActions = {};
    for (const key of CRM_ACTION_KEYS) {
      if (typeof src[key] === "boolean") parsed[key as CrmActionKey] = src[key] as boolean;
    }
    if (Object.keys(parsed).length) pendingCrmActions = parsed;
  }

  try {
    const invite = await issueOrganizationInvite({
      organizationId: orgId,
      email,
      role,
      createdById: r.session.user.id,
      inviteeName,
      pendingRoleId,
      pendingCrmActions,
    });
    return NextResponse.json(
      {
        id: invite.id,
        email: invite.email,
        expiresAt: invite.expiresAt,
        sent: invite.sent,
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro ao criar convite.";
    return NextResponse.json({ message: msg }, { status: 400 });
  }
}
