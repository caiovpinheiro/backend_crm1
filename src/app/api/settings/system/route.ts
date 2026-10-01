import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/auth-helpers";
import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/system");

/**
 * `/api/settings/system` — chaves GLOBAIS da plataforma EduIT.
 *
 * Multi-tenancy v0: este endpoint era usado para gravar config genérica
 * (visibility, selfAssign, loss_reason_required), mas como
 * `system_settings` não tem `organizationId`, essas chaves vazavam
 * entre tenants. Foram migradas para `OrganizationSetting` em
 * `20260601000000_authz_foundation` + `20260601000003_org_settings_loss_reason_cutover`.
 *
 * Hoje este endpoint serve **apenas chaves cross-tenant** (license keys
 * EduIT, feature flags da plataforma) e exige super-admin EduIT.
 *
 * Para chaves per-tenant, use `/api/settings/org`.
 */

const ORG_SCOPED_KEY_PATTERNS = [
  /^visibility\./i,
  /^selfAssign\./i,
  /^deals\./i,
  /^ai\./i,
  /^onboarding\./i,
  /^branding\./i,
  /^loss_reason_required$/i,
];

function isOrgScopedKey(key: string): boolean {
  return ORG_SCOPED_KEY_PATTERNS.some((re) => re.test(key));
}

export async function GET(request: Request) {
  const r = await requireSuperAdmin();
  if (!r.ok) return r.response;

  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  try {
    if (key) {
      const setting = await prismaBase.systemSetting.findUnique({
        where: { key },
      });
      return NextResponse.json({ key, value: setting?.value ?? null });
    }
    const settings = await prismaBase.systemSetting.findMany();
    const map: Record<string, string> = {};
    for (const s of settings) map[s.key] = s.value;
    return NextResponse.json(map);
  } catch (err) {
    log.error({ err }, "[settings/system] GET falhou");
    return NextResponse.json(
      { message: "Erro ao buscar configuração." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const r = await requireSuperAdmin();
  if (!r.ok) return r.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  const b = body as { key?: unknown; value?: unknown };
  const key = typeof b.key === "string" ? b.key.trim() : "";
  const value = typeof b.value === "string" ? b.value : "";
  if (!key) {
    return NextResponse.json({ message: "key é obrigatório." }, { status: 400 });
  }

  if (isOrgScopedKey(key)) {
    return NextResponse.json(
      {
        message:
          "Esta chave é per-organização. Use POST /api/settings/org no contexto de uma org.",
        key,
      },
      { status: 400 },
    );
  }

  try {
    const setting = await prismaBase.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    return NextResponse.json(setting);
  } catch (err) {
    log.error({ err }, "[settings/system] PUT falhou");
    return NextResponse.json(
      { message: "Erro ao salvar configuração." },
      { status: 500 },
    );
  }
}
