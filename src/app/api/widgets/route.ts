import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { listWidgetsWithState } from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/widgets");

/**
 * GET /api/widgets
 * Lista o catalogo de widgets mesclado com o estado de instalacao da org.
 * Disponivel para qualquer usuario autenticado da organizacao (leitura).
 */
export async function GET() {
  return withOrgContext(async () => {
    try {
      const items = await listWidgetsWithState();
      return NextResponse.json({ items });
    } catch (e) {
      log.error({ err: e }, "[GET /api/widgets] falhou");
      return NextResponse.json(
        { message: "Erro ao listar widgets." },
        { status: 500 },
      );
    }
  });
}
