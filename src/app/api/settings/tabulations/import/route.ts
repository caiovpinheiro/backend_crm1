import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { importFlat } from "@/services/tabulations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/settings/tabulations/import");

/**
 * POST /api/settings/tabulations/import
 *   body: { departmentId, rows: [{ id?, parentId?, name, active?, position? }] }
 * → cria/atualiza tabulações do departamento (não-destrutivo). Atualiza
 *   por `id` (round-trip do CSV exportado) e cria linhas sem id.
 *
 * Role: ADMIN ou MANAGER.
 */
const RowSchema = z.object({
  id: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  name: z.string().min(1).max(120),
  active: z.boolean().nullable().optional(),
  position: z.number().int().nullable().optional(),
});

const ImportSchema = z.object({
  departmentId: z.string().min(1),
  rows: z.array(RowSchema).min(1).max(2000),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    const parsed = ImportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados inválidos." }, { status: 400 });
    }
    try {
      const result = await importFlat(parsed.data.departmentId, parsed.data.rows);
      return NextResponse.json(result);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "DEPT_NOT_FOUND") {
        return NextResponse.json({ message: "Departamento não encontrado.", code }, { status: 404 });
      }
      log.error({ err: e }, "[tabulations][import] falhou");
      return NextResponse.json({ message: "Erro ao importar tabulações." }, { status: 500 });
    }
  });
}
