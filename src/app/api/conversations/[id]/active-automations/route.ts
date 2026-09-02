import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requireConversationAccess } from "@/lib/conversation-access";
import { getContactActiveContexts } from "@/services/automation-context";
import { labelForActiveStep } from "@/services/automation-step-labels";
import { getConversationLite } from "@/services/conversations";

type RouteContext = { params: Promise<{ id: string }> };

export type ActiveAutomationDto = {
  contextId: string;
  automationId: string;
  name: string;
  status: "RUNNING" | "PAUSED";
  /** Descrição amigável do passo atual (ex.: "Aguardando resposta do lead"). */
  stepLabel: string | null;
  /** Quando o passo atual expira por timeout (ISO) — null se sem cronômetro. */
  timeoutAt: string | null;
  /** Última atividade do fluxo (ISO). */
  updatedAt: string;
};

/**
 * GET /api/conversations/:id/active-automations
 *
 * Automações vivas (RUNNING/PAUSED) do CONTATO da conversa — alimenta o
 * chip "robô em execução" no header do inbox. O vínculo é por contato
 * porque `AutomationContext` não referencia conversa (modelo de ticket:
 * o fluxo sobrevive à troca de ticket).
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const { id } = await context.params;
      const denied = await requireConversationAccess({ user: authResult.user }, id);
      if (denied) return denied;

      const conv = await getConversationLite(id);
      if (!conv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }
      if (!conv.contactId) {
        return NextResponse.json({ items: [] });
      }

      const contexts = await getContactActiveContexts(conv.contactId);
      const items: ActiveAutomationDto[] = contexts.map((ctx) => {
        const step = ctx.currentStepId
          ? ctx.automation.steps.find((s) => s.id === ctx.currentStepId)
          : null;
        return {
          contextId: ctx.id,
          automationId: ctx.automationId,
          name: ctx.automation.name,
          status: ctx.status as "RUNNING" | "PAUSED",
          stepLabel: step
            ? labelForActiveStep(step.type, ctx.timeoutAt)
            : null,
          timeoutAt: ctx.timeoutAt ? ctx.timeoutAt.toISOString() : null,
          updatedAt: ctx.updatedAt.toISOString(),
        };
      });

      return NextResponse.json({ items });
    });
  } catch (e) {
    console.error("[active-automations] error:", e);
    return NextResponse.json({ message: "Erro ao buscar automações ativas." }, { status: 500 });
  }
}
