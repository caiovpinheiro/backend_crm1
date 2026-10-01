/**
 * GET /api/automations/[id]/audit
 *
 * Roda a auditoria determinística em uma única automação e devolve
 * o relatório de issues (erros, warnings, infos). Usado pelo painel
 * lateral do editor e pelo Copilot via tool `run_audit`.
 *
 * Parâmetros opcionais:
 *   - includeCrossConflicts=true  → inclui candidatos a conflito com
 *     outras automações ativas (só retorna os pares relevantes pra esta).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  auditAutomation,
  detectCrossConflictCandidates,
  type AutomationLike,
} from "@/lib/automation-auditor";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/[id]/audit");

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const url = new URL(request.url);
      const includeCross = url.searchParams.get("includeCrossConflicts") === "true";

      const automation = await prisma.automation.findUnique({
        where: { id },
        include: { steps: { orderBy: { position: "asc" } } },
      });

      if (!automation) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

      const autoLike: AutomationLike = {
        id: automation.id,
        name: automation.name,
        triggerType: automation.triggerType,
        triggerConfig: automation.triggerConfig,
        active: automation.active,
        steps: automation.steps.map((s) => ({
          id: s.id,
          type: s.type,
          config: s.config,
        })),
      };

      const report = auditAutomation(autoLike);

      let crossConflicts: ReturnType<typeof detectCrossConflictCandidates> = [];
      if (includeCross) {
        const actives = await prisma.automation.findMany({
          where: { active: true },
          include: { steps: { orderBy: { position: "asc" } } },
        });
        const allLike: AutomationLike[] = actives.map((a) => ({
          id: a.id,
          name: a.name,
          triggerType: a.triggerType,
          triggerConfig: a.triggerConfig,
          active: a.active,
          steps: a.steps.map((s) => ({ id: s.id, type: s.type, config: s.config })),
        }));
        crossConflicts = detectCrossConflictCandidates(allLike).filter((c) =>
          c.automationIds.includes(id),
        );
      }

      return NextResponse.json({ ...report, crossConflicts });
    } catch (e) {
      log.error({ err: e }, "[audit automation] falhou");
      return NextResponse.json({ message: "Erro ao auditar automação." }, { status: 500 });
    }
  });
}
