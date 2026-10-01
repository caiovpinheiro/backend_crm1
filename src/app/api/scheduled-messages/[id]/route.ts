import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  cancelScheduledMessage,
  getScheduledMessage,
} from "@/services/scheduled-messages";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/scheduled-messages/[id]");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/scheduled-messages/:id
 * Cancelamento manual. Qualquer membro da equipe autenticado com acesso
 * à conversa pode cancelar (mesma regra do inbox: auth valida quem está
 * logado; a conversa é filtrada pelo nível superior da aplicação).
 */
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const uid = session.user.id as string;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ message: "ID inválido." }, { status: 400 });
    }

    const existing = await getScheduledMessage(id);
    if (!existing) {
      return NextResponse.json(
        { message: "Agendamento não encontrado." },
        { status: 404 },
      );
    }

    const updated = await cancelScheduledMessage(id, uid);
    return NextResponse.json(updated);
  } catch (e) {
    log.error({ err: e }, "DELETE /api/scheduled-messages/:id error");
    return NextResponse.json(
      { message: "Erro ao cancelar agendamento." },
      { status: 500 },
    );
  }
}
