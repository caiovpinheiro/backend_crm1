import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  deleteSmtpRelaySettings,
  getSmtpRelaySettings,
  isSmtpRelayFieldError,
  parseUpsertInput,
  upsertSmtpRelaySettings,
} from "@/services/smtp-relay";

export const dynamic = "force-dynamic";

/**
 * Relay SMTP (smarthost) por org — fallback de saída quando o provedor de
 * cloud bloqueia 465/587. Org-scoped (prisma extension injeta
 * organizationId; requireAuth ativa o RequestContext). A senha NUNCA sai
 * na resposta — o GET expõe apenas `hasPassword`.
 */
export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:email");
  if (denied) return denied;

  const settings = await getSmtpRelaySettings();
  return NextResponse.json({ settings });
}

export async function PUT(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:email");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, field: "host", message: "JSON inválido." },
      { status: 400 },
    );
  }

  const parsed = parseUpsertInput(body);
  if (isSmtpRelayFieldError(parsed)) {
    return NextResponse.json(parsed, { status: 400 });
  }

  const settings = await upsertSmtpRelaySettings(parsed);
  return NextResponse.json({ settings });
}

export async function DELETE() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:email");
  if (denied) return denied;

  await deleteSmtpRelaySettings();
  return NextResponse.json({ ok: true });
}
