import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import type { AppUserRole } from "@/lib/auth-types";
import {
  BOTTOM_NAV_MAX,
  DEFAULT_BOTTOM_NAV,
  DEFAULT_ENABLED,
  ensureEnabledModules,
  ensurePinnedBottomNav,
  type MobileLayoutConfigDto,
  sanitizeModuleIds,
  serializeModuleIds,
} from "@/lib/mobile-layout";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";

/**
 * GET /api/mobile-layout
 * Lê a configuração da organização corrente. Se não existir ainda,
 * retorna defaults (sem criar a row — só persistimos no primeiro
 * PUT). Resposta sempre 200 com o DTO completo, simplificando o
 * consumo no front.
 *
 * Autenticado mas sem restrição de role: o app mobile precisa ler
 * pra renderizar a navegação, qualquer operador autenticado pode.
 */
// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function GET() {
  return withOrgContext(async () => {
    // A extension de organization-scope (src/lib/prisma.ts) injeta
    // where.organizationId automaticamente — não precisa (nem deve)
    // filtrar por id fixo, já que agora é uma linha por organização.
    //
    // `select` explícito: NÃO incluir `visualChrome` (feature removida).
    // Evita P2022 caso a coluna não exista em bancos de prod ainda não
    // migrados — ver schema.prisma para o campo legado.
    const row = await prisma.mobileLayoutConfig.findFirst({
      select: {
        bottomNavModuleIds: true,
        enabledModuleIds: true,
        startRoute: true,
        brandColor: true,
        version: true,
      },
    });

    const dto: MobileLayoutConfigDto = row
      ? {
          bottomNav: ensurePinnedBottomNav(
            sanitizeModuleIds(row.bottomNavModuleIds, {
              ensureRequired: true,
              maxItems: BOTTOM_NAV_MAX,
            }),
          ),
          enabled: ensureEnabledModules(
            sanitizeModuleIds(row.enabledModuleIds, {
              ensureRequired: true,
            }),
          ),
          startRoute: row.startRoute,
          brandColor: row.brandColor,
          version: row.version,
        }
      : {
          bottomNav: DEFAULT_BOTTOM_NAV,
          enabled: DEFAULT_ENABLED,
          startRoute: "/dashboard",
          brandColor: null,
          version: 0,
        };

    return NextResponse.json(dto);
  });
}

/**
 * PUT /api/mobile-layout
 * Sobrescreve a configuração da organização corrente. ADMIN ou MANAGER.
 * Valida e sanitiza tudo no servidor (não confia no cliente).
 */
export async function PUT(request: Request) {
  return withOrgContext(async (session) => {
    const role = (session.user as { role?: AppUserRole }).role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "Apenas administradores e gestores podem editar o layout do app.",
        },
        { status: 403 },
      );
    }

    const organizationId = getOrgIdOrNull();
    if (!organizationId) {
      return NextResponse.json({ error: "missing_organization" }, { status: 400 });
    }

    let body: {
      bottomNav?: string[];
      enabled?: string[];
      startRoute?: string;
      brandColor?: string | null;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // Sanitização: enabled DEVE conter required (Inbox); bottomNav é
    // subset de enabled (não faz sentido habilitar item no nav que
    // está desativado globalmente).
    const enabled = sanitizeModuleIds(body.enabled, { ensureRequired: true });
    const bottomNav = sanitizeModuleIds(body.bottomNav, {
      ensureRequired: true,
      maxItems: BOTTOM_NAV_MAX,
    }).filter((id) => enabled.includes(id));

    // bottomNav após filtro pode ter perdido o required — re-injeta.
    if (!bottomNav.includes("inbox")) bottomNav.unshift("inbox");

    const startRoute = (body.startRoute ?? "/dashboard").trim() || "/dashboard";
    const brandColor =
      typeof body.brandColor === "string" && /^#[0-9a-fA-F]{6}$/.test(body.brandColor)
        ? body.brandColor
        : body.brandColor === null
          ? null
          : undefined; // ignora valor inválido

    // `select` explícito: NÃO incluir `visualChrome` (feature removida).
    // Evita P2022 caso a coluna não exista em bancos de prod ainda não
    // migrados — ver schema.prisma para o campo legado.
    const updated = await prisma.mobileLayoutConfig.upsert({
      where: { organizationId },
      create: withOrgFromCtx({
        bottomNavModuleIds: serializeModuleIds(bottomNav),
        enabledModuleIds: serializeModuleIds(enabled),
        startRoute,
        brandColor: brandColor ?? null,
        version: 1,
        updatedBy: session.user.id ?? null,
      }),
      update: {
        bottomNavModuleIds: serializeModuleIds(bottomNav),
        enabledModuleIds: serializeModuleIds(enabled),
        startRoute,
        ...(brandColor !== undefined ? { brandColor } : {}),
        version: { increment: 1 },
        updatedBy: session.user.id ?? null,
      },
      select: {
        bottomNavModuleIds: true,
        enabledModuleIds: true,
        startRoute: true,
        brandColor: true,
        version: true,
      },
    });

    const dto: MobileLayoutConfigDto = {
      bottomNav,
      enabled,
      startRoute: updated.startRoute,
      brandColor: updated.brandColor,
      version: updated.version,
    };

    return NextResponse.json(dto);
  });
}
