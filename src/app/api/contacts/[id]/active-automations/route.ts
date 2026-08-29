import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getContactActiveContexts } from "@/services/automation-context";
import { labelForActiveStep } from "@/services/automation-step-labels";

type Ctx = { params: Promise<{ id: string }> };

export type ActiveAutomationDto = {
  contextId: string;
  automationId: string;
  name: string;
  status: "RUNNING" | "PAUSED";
  stepLabel: string | null;
  timeoutAt: string | null;
  updatedAt: string;
};

/**
 * GET /api/contacts/:id/active-automations
 *
 * Automações vivas (RUNNING/PAUSED) do contato — alimenta o botão
 * "Robôs ativos" ao lado da composer (inbox e deal). O vínculo é por
 * contato porque `AutomationContext` não referencia conversa.
 */
export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    try {
      const { id } = await ctx.params;
      const contexts = await getContactActiveContexts(id);
      const items: ActiveAutomationDto[] = contexts.map((c) => {
        const step = c.currentStepId
          ? c.automation.steps.find((s) => s.id === c.currentStepId)
          : null;
        return {
          contextId: c.id,
          automationId: c.automationId,
          name: c.automation.name,
          status: c.status as "RUNNING" | "PAUSED",
          stepLabel: step
            ? labelForActiveStep(step.type, c.timeoutAt)
            : null,
          timeoutAt: c.timeoutAt ? c.timeoutAt.toISOString() : null,
          updatedAt: c.updatedAt.toISOString(),
        };
      });
      return NextResponse.json({ items });
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao buscar automações ativas." },
        { status: 500 },
      );
    }
  });
}
