import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { getConversationById } from "@/services/conversations";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      // Access/404 antes de hidratar preview — 8× GET :id sem permissão
      // não pode pagar o join em messages.
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;
      const row = await getConversationById(id);
      if (!row) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }

      return NextResponse.json(row);
    } catch (e) {
      console.error(e);
      return NextResponse.json({ message: "Erro ao carregar conversa." }, { status: 500 });
    }
  });
}
