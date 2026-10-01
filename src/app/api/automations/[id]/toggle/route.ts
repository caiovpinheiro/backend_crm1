import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAutomationById, toggleAutomation } from "@/services/automations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/[id]/toggle");

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:edit");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const existing = await getAutomationById(id);
      if (!existing) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

      try {
        const automation = await toggleAutomation(id);
        return NextResponse.json(automation);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "NOT_FOUND") {
          return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
        }
        if (err instanceof Error && err.message === "MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP") {
          return NextResponse.json(
            {
              message:
                "Selecione o canal do primeiro passo de mensagem — a organização tem mais de um canal conectado.",
              code: "MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP",
            },
            { status: 400 },
          );
        }
        throw err;
      }
    } catch (e: unknown) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json({ message: "Erro ao alternar automação." }, { status: 500 });
    }
  });
}
