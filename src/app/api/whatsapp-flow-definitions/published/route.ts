import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { listPublishedFlowDefinitions } from "@/services/whatsapp-flow-definitions";

/**
 * GET /api/whatsapp-flow-definitions/published
 *
 * Catálogo de formulários (WhatsApp Flow) publicados, para qualquer
 * membro autenticado da org — inbox "/" e editor de automação.
 * O GET raiz continua ADMIN/MANAGER (inclui rascunhos).
 */
export async function GET() {
  return withOrgContext(async () => {
    try {
      const items = await listPublishedFlowDefinitions();
      return NextResponse.json(items);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
