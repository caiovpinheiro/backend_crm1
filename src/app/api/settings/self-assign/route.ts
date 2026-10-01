import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import type { AppUserRole } from "@/lib/auth-types";
import {
  canRoleSelfAssign,
  getSelfAssignSettings,
  setSelfAssignForRole,
} from "@/lib/self-assign";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/self-assign");

// Bug 27/abr/26: usavamos `auth()` direto. getSelfAssignSettings/setSelf
// AssignForRole leem/escrevem OrganizationSetting via Prisma extension
// multi-tenant — exige RequestContext ativo. Migrado para withOrgContext.

/**
 * GET retorna para qualquer sessão autenticada:
 *  - settings: flags por role (default público para UI admin consumir)
 *  - self.canSelfAssign: capacidade do usuário atual (usado pelo inbox)
 */
export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const role = (session.user as { role?: AppUserRole }).role;
      const settings = await getSelfAssignSettings();
      const canSelfAssign = await canRoleSelfAssign(role ?? null);

      return NextResponse.json({
        settings,
        self: {
          role: role ?? null,
          canSelfAssign,
        },
      });
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json(
        { message: "Erro ao carregar configurações." },
        { status: 500 }
      );
    }
  });
}

export async function PUT(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const role = (session.user as { role?: AppUserRole }).role;
      if (role !== "ADMIN") {
        return NextResponse.json(
          { message: "Apenas administradores podem alterar permissões." },
          { status: 403 }
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      if (!body || typeof body !== "object") {
        return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
      }

      const b = body as Record<string, unknown>;
      const updates: { role: "MANAGER" | "MEMBER"; enabled: boolean }[] = [];

      for (const r of ["MANAGER", "MEMBER"] as const) {
        if (b[r] !== undefined) {
          if (typeof b[r] !== "boolean") {
            return NextResponse.json(
              { message: `Valor inválido para ${r}; esperado boolean.` },
              { status: 400 }
            );
          }
          updates.push({ role: r, enabled: b[r] as boolean });
        }
      }

      if (updates.length === 0) {
        return NextResponse.json(
          { message: "Nenhuma alteração fornecida." },
          { status: 400 }
        );
      }

      for (const u of updates) {
        await setSelfAssignForRole(u.role, u.enabled);
      }

      const settings = await getSelfAssignSettings();
      return NextResponse.json({ settings });
    } catch (e) {
      log.error({ err: e }, "PUT falhou");
      return NextResponse.json(
        { message: "Erro ao salvar configurações." },
        { status: 500 }
      );
    }
  });
}
