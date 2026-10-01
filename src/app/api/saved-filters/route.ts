import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { createSavedFilter, listSavedFilters } from "@/services/saved-filters";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/saved-filters");

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const user = session.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };
      const entityType = new URL(request.url).searchParams.get("entityType") ?? undefined;
      const items = await listSavedFilters(user, entityType);
      return NextResponse.json({ items });
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar filtros." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const user = session.user as { id: string; role: "ADMIN" | "MANAGER" | "MEMBER" };
      const body = (await request.json().catch(() => null)) as {
        name?: string;
        entityType?: string;
        filterConfig?: Record<string, unknown>;
        isShared?: boolean;
        isDefault?: boolean;
      } | null;
      if (!body || !body.name || !body.name.trim()) {
        return NextResponse.json({ message: "Nome obrigatório." }, { status: 400 });
      }
      const created = await createSavedFilter(user, {
        name: body.name,
        entityType: body.entityType,
        filterConfig: body.filterConfig,
        isShared: body.isShared,
        isDefault: body.isDefault,
      });
      return NextResponse.json(created, { status: 201 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao criar filtro.";
      const status = /permiss[ãa]o|administrador|obrigat/i.test(msg) ? 403 : 500;
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
