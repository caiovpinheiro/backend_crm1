import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
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
 * organizationId). A senha NUNCA sai na resposta — o GET expõe apenas
 * `hasPassword`.
 *
 * Bug 09/set/26 (dev): a rota usava `requireAuth()` direto e o service
 * chamava `getOrgIdOrThrow()` — o `enterWith` do requireAuth NÃO propaga
 * o ALS pro handler no build de produção, então todo PUT/DELETE caía em
 * 500 "organization context ausente" e nada era salvo (GET sobrevivia
 * pelo fallback de cookie da Prisma extension). Mesma classe do bug de
 * 24/jun/26 em /api/settings/org — por isso `withOrgContext` aqui.
 */
export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "settings:email");
    if (denied) return denied;

    const settings = await getSmtpRelaySettings();
    return NextResponse.json({ settings });
  });
}

export async function PUT(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "settings:email");
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
  });
}

export async function DELETE() {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "settings:email");
    if (denied) return denied;

    await deleteSmtpRelaySettings();
    return NextResponse.json({ ok: true });
  });
}
